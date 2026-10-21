/**
 * Sets one model, one thinking level, or both on every open thread at once,
 * and puts the previous selections back on request.
 *
 * A thread's selection is what its next turn runs on, so the change takes
 * effect with the next message in each thread; a run under way is not touched.
 * The selections that were replaced are kept in a file in the state directory,
 * so the way back survives a restart.
 *
 * A call can cover all open threads, only the threads scheduled tasks post to,
 * or only the others, so tasks and ad-hoc work can run on different models.
 *
 * @module OpenThreadModelOverride
 */
import {
  CommandId,
  ModelSelection,
  ThreadId,
  type ModelOverrideScope,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { overriddenModelSelection, type ModelOverride } from "@t3tools/shared/modelOverride";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import {
  forgetStandingOverride,
  readStandingOverride,
  rememberStandingOverride,
  scopeCovers,
  switchWaitsForRun,
  type ThreadScope,
} from "./StandingModelOverride.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const MODEL_OVERRIDE_FILE_NAME = "open-thread-model-override.json";

/**
 * Per thread: what it had before the first override, what the override set,
 * and the part it was counted in then.
 */
const SavedSelections = Schema.Record(
  ThreadId,
  Schema.Struct({
    previous: ModelSelection,
    applied: ModelSelection,
    scope: Schema.optional(Schema.Literals(["tasks", "adhoc"])),
  }),
);
type SavedSelections = typeof SavedSelections.Type;
const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(SavedSelections));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(SavedSelections));

/**
 * Open means the user still has it on the list: not archived, deleted or
 * settled. A subagent's thread is not on the list; it belongs to the run that
 * started it and is left alone.
 */
export function isOpenThread(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "settledAt" | "settledOverride" | "lineage"
  >,
): boolean {
  return (
    thread.lineage.relationshipToParent !== "subagent" &&
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    (thread.settledAt === null || thread.settledOverride === "active")
  );
}

/** A thread a scheduled task posts to counts as a task thread, whether the task is on or not. */
export function threadScopeOf(threadId: string, taskThreadIds: ReadonlySet<string>): ThreadScope {
  return taskThreadIds.has(threadId) ? "tasks" : "adhoc";
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, MODEL_OVERRIDE_FILE_NAME);
  const lock = yield* Semaphore.make(1);

  const readSaved = fileSystem.readFileString(filePath).pipe(
    Effect.map((contents) => {
      const decoded = decodeSaved(contents);
      return decoded._tag === "Some" ? decoded.value : ({} as SavedSelections);
    }),
    Effect.orElseSucceed(() => ({}) as SavedSelections),
  );

  // Read on every call: tasks are bound to threads and moved between them at any time.
  const taskThreadIds = scheduledTasks
    .list()
    .pipe(
      Effect.map(
        (result) =>
          new Set(result.tasks.flatMap((task) => (task.threadId === null ? [] : [task.threadId]))),
      ),
    );

  const withStateServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, config),
    );
  const standing = withStateServices(readStandingOverride);
  const noSelections: Array<{ threadId: ThreadId; modelSelection: ModelSelection }> = [];

  const apply = Effect.fn("OpenThreadModelOverride.apply")(function* (input: {
    readonly commandId: CommandId;
    readonly override: ModelOverride;
    readonly scope: ModelOverrideScope;
  }) {
    // Nothing asked for: only say what is in force.
    if (input.override.model === undefined && input.override.effort === undefined) {
      return { threads: 0, changed: noSelections, standing: yield* standing };
    }
    const providers = yield* registry.getProviders;
    const shell = yield* threads.getShellSnapshot();
    const tasks = yield* taskThreadIds;
    const saved: Record<string, SavedSelections[ThreadId]> = { ...(yield* readSaved) };
    const selections: Array<{ threadId: ThreadId; modelSelection: ModelSelection }> = [];
    let changed = 0;
    for (const thread of shell.threads) {
      if (!isOpenThread(thread)) continue;
      const scope = threadScopeOf(thread.id, tasks);
      if (!scopeCovers(input.scope, scope)) continue;
      const next = overriddenModelSelection({
        current: thread.modelSelection,
        override: input.override,
        providers,
      });
      if (next === null) {
        // Already there: still reported, so a client whose composer shows an
        // older pick for this thread can line it up. Messages waiting in its
        // queue may still carry an older model and would move the thread back.
        selections.push({ threadId: thread.id, modelSelection: thread.modelSelection });
        yield* threads
          .dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`${input.commandId}:queued:${thread.id}`),
            threadId: thread.id,
            modelSelection: thread.modelSelection,
            includeQueuedRuns: true,
          })
          .pipe(Effect.ignore);
        continue;
      }
      if (
        switchWaitsForRun({
          activeRunId: thread.activeRunId,
          current: thread.modelSelection,
          next,
        })
      ) {
        // Reported so the composer offers the new model for the next message.
        selections.push({ threadId: thread.id, modelSelection: next });
        continue;
      }
      const set = yield* threads
        .dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${input.commandId}:model:${thread.id}`),
          threadId: thread.id,
          modelSelection: next,
          includeQueuedRuns: true,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("Could not set the model of a thread", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      if (!set) continue;
      changed += 1;
      selections.push({ threadId: thread.id, modelSelection: next });
      // A second override on top of the first still restores to the original.
      saved[thread.id] = {
        previous: saved[thread.id]?.previous ?? thread.modelSelection,
        applied: next,
        scope,
      };
    }
    if (changed > 0) {
      yield* fileSystem.writeFileString(filePath, encodeSaved(saved as SavedSelections));
    }
    // Threads that open again later, or that an automation wakes, follow too.
    yield* withStateServices(rememberStandingOverride(input.override, input.scope));
    yield* Effect.logInfo("Model set on open threads", { threads: changed, scope: input.scope });
    return { threads: changed, changed: selections, standing: yield* standing };
  });

  const restore = Effect.fn("OpenThreadModelOverride.restore")(function* (input: {
    readonly commandId: CommandId;
    readonly scope: ModelOverrideScope;
  }) {
    const saved = yield* readSaved;
    const shell = yield* threads.getShellSnapshot();
    const tasks = yield* taskThreadIds;
    const byId = new Map(shell.threads.map((thread) => [thread.id as string, thread]));
    const restored: Array<{ threadId: ThreadId; modelSelection: ModelSelection }> = [];
    const kept: Record<string, SavedSelections[ThreadId]> = {};
    for (const [threadId, entry] of Object.entries(saved)) {
      // The other part keeps its saved selections for its own "Put back".
      if (!scopeCovers(input.scope, entry.scope ?? threadScopeOf(threadId, tasks))) {
        kept[threadId] = entry;
        continue;
      }
      const thread = byId.get(threadId);
      // A thread the user has moved to another model since then keeps that choice.
      if (
        thread === undefined ||
        thread.archivedAt !== null ||
        !modelSelectionsEqual(thread.modelSelection, entry.applied)
      )
        continue;
      const set = yield* threads
        .dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${input.commandId}:model:${threadId}`),
          threadId: thread.id,
          modelSelection: entry.previous,
          includeQueuedRuns: true,
        })
        .pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      if (set) restored.push({ threadId: thread.id, modelSelection: entry.previous });
    }
    if (Object.keys(kept).length === 0) {
      yield* fileSystem.remove(filePath).pipe(Effect.ignore);
    } else {
      yield* fileSystem.writeFileString(filePath, encodeSaved(kept as SavedSelections));
    }
    yield* withStateServices(forgetStandingOverride(input.scope));
    yield* Effect.logInfo("Previous models restored on open threads", {
      threads: restored.length,
      scope: input.scope,
    });
    return { threads: restored.length, changed: restored, standing: yield* standing };
  });

  return {
    /** Sets the override on the open threads `scope` covers and reports how many changed. */
    apply: (input: Parameters<typeof apply>[0]) => lock.withPermits(1)(apply(input)),
    /** Puts back what `apply` replaced in `scope`, where the thread still has what it set. */
    restore: (input: Parameters<typeof restore>[0]) => lock.withPermits(1)(restore(input)),
  };
});
