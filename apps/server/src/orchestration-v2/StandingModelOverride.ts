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
import { CommandId, ModelSelection, TrimmedNonEmptyString } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
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
import { isOpenThread, MODEL_OVERRIDE_FILE_NAME } from "./OpenThreadModelOverride.ts";
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

/**
 * The override that a set of applied selections stands for: the model when
 * they all share one, the thinking level when they all share one. Used for an
 * override set before its terms were kept, so it holds without setting it again.
 */
export function standingOverrideFromApplied(
  applied: ReadonlyArray<ModelSelection>,
): ModelOverride | null {
  const [first, ...rest] = applied;
  if (first === undefined) return null;
  const effortOf = (selection: ModelSelection) =>
    selection.options?.find((option) => /effort/i.test(option.id))?.value;
  const sameModel = rest.every(
    (selection) => selection.instanceId === first.instanceId && selection.model === first.model,
  );
  const effort = effortOf(first);
  const sameEffort =
    typeof effort === "string" && rest.every((selection) => effortOf(selection) === effort);
  if (!sameModel && !sameEffort) return null;
  return {
    ...(sameModel ? { model: { instanceId: first.instanceId, model: first.model } } : {}),
    ...(sameEffort ? { effort } : {}),
  };
}

const AppliedSelections = Schema.Record(
  Schema.String,
  Schema.Struct({ previous: ModelSelection, applied: ModelSelection }),
);
const decodeApplied = Schema.decodeUnknownOption(Schema.fromJsonString(AppliedSelections));
const encodeApplied = Schema.encodeSync(Schema.fromJsonString(AppliedSelections));

/**
 * Whether the user has picked another model for this thread since the
 * override set one on it. That choice is theirs: an automation's next message
 * must not move the thread back.
 */
export function userChoseOtherModel(
  applied: ModelSelection | undefined,
  current: ModelSelection,
): boolean {
  return applied !== undefined && !modelSelectionsEqual(current, applied);
}

/** The override in force, or null. */
export const readStandingOverride = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const stored = yield* fileSystem.readFileString(yield* filePath).pipe(
    Effect.map((contents) => Option.getOrNull(decodeStored(contents)) as ModelOverride | null),
    Effect.orElseSucceed(() => null),
  );
  if (stored !== null) return stored;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const applied = yield* fileSystem
    .readFileString(path.join(config.stateDir, MODEL_OVERRIDE_FILE_NAME))
    .pipe(
      Effect.map(decodeApplied),
      Effect.orElseSucceed(() => Option.none()),
    );
  const derived = Option.isNone(applied)
    ? null
    : standingOverrideFromApplied(Object.values(applied.value).map((entry) => entry.applied));
  // Kept once read: threads aligned later may stay on their own account, and
  // the applied selections then no longer share one account to read it from.
  if (derived !== null) yield* rememberStandingOverride(derived);
  return derived;
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
    const fileSystem = yield* FileSystem.FileSystem;
    const savedPath = (yield* Path.Path).join(
      (yield* ServerConfig.ServerConfig).stateDir,
      MODEL_OVERRIDE_FILE_NAME,
    );
    const noneSaved: typeof AppliedSelections.Type = {};
    const saved: typeof AppliedSelections.Type = yield* fileSystem.readFileString(savedPath).pipe(
      Effect.map((contents) => Option.getOrElse(decodeApplied(contents), () => noneSaved)),
      Effect.orElseSucceed(() => noneSaved),
    );
    if (userChoseOtherModel(saved[threadId]?.applied, thread.modelSelection)) {
      yield* recordDecision({
        kind: "model-override-applied",
        threadId,
        outcome: "kept-own-choice",
        facts: {
          reason,
          current: `${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
        },
      });
      return;
    }
    const next = standingSelectionFor({
      override,
      thread,
      providers: yield* registry.value.getProviders,
    });
    if (next === null) return;
    yield* threads.dispatch({
      type: "thread.model-selection.set",
      // One id per alignment: a reused id would be dropped.
      commandId: CommandId.make(
        `command:standing-model-override:${threadId}:${yield* Clock.currentTimeMillis}`,
      ),
      threadId,
      modelSelection: next,
      includeQueuedRuns: true,
    });
    // Remembered like the threads the override covered at first: "Put back"
    // restores this one too, and a later pick by the user is told apart.
    yield* fileSystem
      .writeFileString(
        savedPath,
        encodeApplied({
          ...saved,
          [threadId]: {
            previous: saved[threadId]?.previous ?? thread.modelSelection,
            applied: next,
          },
        }),
      )
      .pipe(Effect.ignore);
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
