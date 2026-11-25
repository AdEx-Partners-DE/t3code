/**
 * Moves the threads of one provider instance to another instance of the same driver: another
 * account of the same vendor. Model and options stay; the next turn starts on the new account
 * with a context handoff. Swapping back is the same call with the instances exchanged.
 * @module ProviderInstanceSwap
 */
import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestratorProviderSelectionBusyError } from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class ProviderInstanceSwapError extends Schema.TaggedError<ProviderInstanceSwapError>()(
  "ProviderInstanceSwapError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ProviderInstanceSwapInput {
  readonly commandId: CommandId;
  readonly fromInstanceId: ProviderInstanceId;
  readonly toInstanceId: ProviderInstanceId;
  readonly includeArchived?: boolean | undefined;
  readonly includeTextGeneration?: boolean | undefined;
}

export interface ProviderInstanceSwapResult {
  readonly moved: number;
  readonly busy: ReadonlyArray<ThreadId>;
  readonly failed: ReadonlyArray<{ readonly threadId: ThreadId; readonly reason: string }>;
  readonly scheduledTasksMoved: number;
  readonly textGenerationMoved: boolean;
}

const isSelectionBusy = Schema.is(OrchestratorProviderSelectionBusyError);

/** Why `from` → `to` is not a swap between two accounts of one vendor, or null when it is. */
export function swapRefusal(
  providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly driver: string;
    readonly enabled: boolean;
  }>,
  fromInstanceId: string,
  toInstanceId: string,
): string | null {
  if (fromInstanceId === toInstanceId) return "Pick another account to move the threads to.";
  const from = providers.find((provider) => provider.instanceId === fromInstanceId);
  const to = providers.find((provider) => provider.instanceId === toInstanceId);
  if (from === undefined) return `Unknown provider instance "${fromInstanceId}".`;
  if (to === undefined) return `Unknown provider instance "${toInstanceId}".`;
  if (from.driver !== to.driver)
    return `"${fromInstanceId}" and "${toInstanceId}" are different providers; only accounts of the same provider can swap.`;
  if (!to.enabled) return `"${toInstanceId}" is turned off.`;
  return null;
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const lock = yield* Semaphore.make(1);

  // Runs once per thread, often over a thousand times; the swap's span covers it.
  const moveThread = Effect.fnUntraced(function* (
    input: ProviderInstanceSwapInput,
    thread: OrchestrationV2ThreadShell,
  ) {
    if (thread.activeRunId !== null) return "busy" as const;
    const enabled = yield* threads.isProviderInstanceEnabledForProject({
      projectId: thread.projectId,
      instanceId: input.toInstanceId,
    });
    if (!enabled) return { reason: "The other account is turned off for this project." };
    return yield* threads
      .dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`${input.commandId}:swap:${thread.id}`),
        threadId: thread.id,
        modelSelection: { ...thread.modelSelection, instanceId: input.toInstanceId },
        // A queued message keeps the selection it was sent with and would move the thread back.
        includeQueuedRuns: true,
      })
      .pipe(
        Effect.as("moved" as const),
        // A run that started since the snapshot was read.
        Effect.catchIf(isSelectionBusy, () => Effect.succeed("busy" as const)),
        Effect.catch((cause) => Effect.succeed({ reason: cause.message })),
      );
  });

  const swap = Effect.fn("ProviderInstanceSwap.swap")(function* (input: ProviderInstanceSwapInput) {
    const refusal = swapRefusal(
      yield* registry.getProviders,
      input.fromInstanceId,
      input.toInstanceId,
    );
    if (refusal !== null) return yield* new ProviderInstanceSwapError({ detail: refusal });

    const active = yield* threads.getShellSnapshot();
    const archived =
      input.includeArchived === true
        ? (yield* threads.getShellSnapshot({ location: "archive" })).threads
        : [];
    const candidates = [...active.threads, ...archived].filter(
      (thread) =>
        thread.deletedAt == null && thread.modelSelection.instanceId === input.fromInstanceId,
    );
    let moved = 0;
    const busy: Array<ThreadId> = [];
    const failed: Array<{ threadId: ThreadId; reason: string }> = [];
    for (const thread of candidates) {
      const outcome = yield* moveThread(input, thread);
      if (outcome === "moved") moved += 1;
      else if (outcome === "busy") busy.push(thread.id);
      else failed.push({ threadId: thread.id, reason: outcome.reason });
    }

    const scheduledTasksMoved = yield* scheduledTasks.retargetProviderInstance({
      fromInstanceId: input.fromInstanceId,
      toInstanceId: input.toInstanceId,
    });

    let textGenerationMoved = false;
    if (input.includeTextGeneration === true) {
      const current = (yield* serverSettings.getSettings).textGenerationModelSelection;
      if (current.instanceId === input.fromInstanceId) {
        // The full selection: a patch naming only the instance would drop the options.
        yield* serverSettings.updateSettings({
          textGenerationModelSelection: { ...current, instanceId: input.toInstanceId },
        });
        textGenerationMoved = true;
      }
    }

    yield* Effect.logInfo("Threads moved to another account", {
      from: input.fromInstanceId,
      to: input.toInstanceId,
      moved,
      busy: busy.length,
      failed: failed.length,
      scheduledTasksMoved,
      textGenerationMoved,
    });
    return {
      moved,
      busy,
      failed,
      scheduledTasksMoved,
      textGenerationMoved,
    } satisfies ProviderInstanceSwapResult;
  });

  return {
    /** Moves `from`'s threads, tasks and optionally the text generation model to `to`. */
    swap: (input: ProviderInstanceSwapInput) => lock.withPermits(1)(swap(input)),
  };
});

/** One per server, so the client and agents share the lock that keeps two swaps from interleaving. */
export class ProviderInstanceSwap extends Context.Service<
  ProviderInstanceSwap,
  Effect.Success<typeof make>
>()("t3/orchestration-v2/ProviderInstanceSwap") {}

export const layer = Layer.effect(ProviderInstanceSwap, make);
