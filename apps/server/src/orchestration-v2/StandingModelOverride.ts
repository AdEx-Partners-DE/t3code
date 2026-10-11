/**
 * Keeps "set this model on all open threads" in force after the click.
 *
 * The override itself is one pass over the threads that are open at that
 * moment. A thread that opens again later, or one an automation wakes up, was
 * not there and would go on with its old model. So the override's own terms
 * are kept in a file until the models are put back, and a thread that is about
 * to get work without the user is brought in line first.
 *
 * @module StandingModelOverride
 */
import { CommandId, TrimmedNonEmptyString, type ModelSelection } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { overriddenModelSelection, type ModelOverride } from "@t3tools/shared/modelOverride";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { recordDecision } from "../decisionLog.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { isOpenThread } from "./OpenThreadModelOverride.ts";
import type * as ThreadManagement from "./ThreadManagementService.ts";

export const STANDING_OVERRIDE_FILE_NAME = "open-thread-model-override.active.json";

const StoredOverride = Schema.Struct({
  model: Schema.optional(
    Schema.Struct({ instanceId: ProviderInstanceId, model: TrimmedNonEmptyString }),
  ),
  effort: Schema.optional(TrimmedNonEmptyString),
});
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredOverride));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredOverride));

const filePath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return path.join(config.stateDir, STANDING_OVERRIDE_FILE_NAME);
});

/** Remembers the override so it also reaches threads that were not open when it was set. */
export const rememberStandingOverride = (override: ModelOverride) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(
      yield* filePath,
      encodeStored({
        ...(override.model === undefined ? {} : { model: override.model }),
        ...(override.effort === undefined ? {} : { effort: override.effort }),
      } as typeof StoredOverride.Type),
    );
  }).pipe(Effect.ignore);

/** "Put back" ends the rule. */
export const forgetStandingOverride = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(yield* filePath);
}).pipe(Effect.ignore);

const readStandingOverride = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFileString(yield* filePath);
  return Option.getOrNull(decodeStored(contents)) as ModelOverride | null;
}).pipe(Effect.orElseSucceed(() => null));

/**
 * The selection a thread should move to under the standing override, or null
 * when there is none, the thread is not open, or it is there already.
 */
export function standingSelectionFor(input: {
  readonly override: ModelOverride | null;
  readonly thread: Parameters<typeof isOpenThread>[0] & {
    readonly modelSelection: ModelSelection;
  };
  readonly providers: Parameters<typeof overriddenModelSelection>[0]["providers"];
}): ModelSelection | null {
  if (input.override === null || !isOpenThread(input.thread)) return null;
  return overriddenModelSelection({
    current: input.thread.modelSelection,
    override: input.override,
    providers: input.providers,
  });
}

/**
 * Brings one thread in line with the standing override before it gets work
 * that does not come from the user. Never fails: a thread that cannot be
 * aligned simply runs on what it has.
 */
export const alignThreadWithStandingOverride = (
  threads: Pick<ThreadManagement.ThreadManagementServiceShape, "getThreadShell" | "dispatch">,
  threadId: Parameters<ThreadManagement.ThreadManagementServiceShape["getThreadShell"]>[0],
  reason: string,
) =>
  Effect.gen(function* () {
    const override = yield* readStandingOverride;
    if (override === null) return;
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    if (Option.isNone(registry)) return;
    const thread = yield* threads.getThreadShell(threadId);
    if (thread === null) return;
    const next = standingSelectionFor({
      override,
      thread,
      providers: yield* registry.value.getProviders,
    });
    if (next === null) return;
    yield* threads.dispatch({
      type: "thread.model-selection.set",
      // One id per alignment: the same thread can need the same model again
      // after the user changed it by hand, and a reused id would be dropped.
      commandId: CommandId.make(
        `command:standing-model-override:${threadId}:${yield* Clock.currentTimeMillis}`,
      ),
      threadId,
      modelSelection: next,
      includeQueuedRuns: true,
    });
    yield* recordDecision({
      kind: "model-override-applied",
      threadId,
      outcome: "aligned",
      facts: {
        reason,
        from: `${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
        to: `${next.instanceId}/${next.model}`,
      },
    });
  }).pipe(Effect.ignore);
