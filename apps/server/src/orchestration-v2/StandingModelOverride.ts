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
import {
  CommandId,
  ModelSelection,
  TrimmedNonEmptyString,
  type ModelOverrideScope,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
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

/** Thread and model of every kept choice already written to the decision log since the server started. */
const keptChoicesRecorded = new Set<string>();

export const STANDING_OVERRIDE_FILE_NAME = "open-thread-model-override.active.json";

const StoredOverride = Schema.Struct({
  model: Schema.optional(
    Schema.Struct({ instanceId: ProviderInstanceId, model: TrimmedNonEmptyString }),
  ),
  effort: Schema.optional(TrimmedNonEmptyString),
  keepOwnAccount: Schema.optional(Schema.Boolean),
});
/** One override per part: threads that scheduled tasks post to, and the others. */
const StoredStanding = Schema.Struct({
  tasks: Schema.optional(StoredOverride),
  adhoc: Schema.optional(StoredOverride),
});
const decodeStanding = Schema.decodeUnknownOption(StoredStanding);
const decodeStored = Schema.decodeUnknownOption(StoredOverride);
const encodeStanding = Schema.encodeSync(Schema.fromJsonString(StoredStanding));

/** The part of the open threads a thread belongs to. */
export type ThreadScope = Exclude<ModelOverrideScope, "all">;

export interface StandingOverrides {
  readonly tasks: ModelOverride | null;
  readonly adhoc: ModelOverride | null;
}

export const NO_STANDING_OVERRIDES: StandingOverrides = { tasks: null, adhoc: null };

/** Whether a call for `scope` covers a thread of the part `thread`. */
export function scopeCovers(scope: ModelOverrideScope, thread: ThreadScope): boolean {
  return scope === "all" || scope === thread;
}

/**
 * Whether a message that starts without the user may move its thread to the
 * standing model first. A provider's own wake (`creationSource: "provider"`)
 * reports work still running in the thread's live session, and the adapter
 * attaches that session's buffered output to it: moving the thread to another
 * account closes the session, which kills that work and loses the output. Such
 * a wake keeps the thread as it is; the next message from a task, an agent or
 * the server aligns it.
 */
export function alignsBeforeMessage(message: {
  readonly modelSelection?: unknown;
  readonly creationSource: string;
}): boolean {
  return message.modelSelection === undefined && message.creationSource !== "provider";
}

/**
 * Reads the kept file. Before the split one override stood for every thread,
 * so a file in that form stands for both parts.
 */
export function parseStandingOverrides(contents: string): StandingOverrides | null {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  if ("tasks" in raw || "adhoc" in raw) {
    const split = Option.getOrNull(decodeStanding(raw));
    return split === null ? null : { tasks: split.tasks ?? null, adhoc: split.adhoc ?? null };
  }
  const single = Option.getOrNull(decodeStored(raw));
  return single === null ? null : { tasks: single, adhoc: single };
}

/** `current` with the parts `scope` covers set to `override`, or cleared with null. */
export function withScopedOverride(
  current: StandingOverrides,
  scope: ModelOverrideScope,
  override: ModelOverride | null,
): StandingOverrides {
  return {
    tasks: scopeCovers(scope, "tasks") ? override : current.tasks,
    adhoc: scopeCovers(scope, "adhoc") ? override : current.adhoc,
  };
}

const storedForm = (override: ModelOverride | null) =>
  override === null
    ? undefined
    : {
        ...(override.model === undefined ? {} : { model: override.model }),
        ...(override.effort === undefined ? {} : { effort: override.effort }),
        ...(override.keepOwnAccount === true ? { keepOwnAccount: true } : {}),
      };

const filePath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return path.join(config.stateDir, STANDING_OVERRIDE_FILE_NAME);
});

const readKept = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(yield* filePath).pipe(
    Effect.map(parseStandingOverrides),
    Effect.orElseSucceed(() => null),
  );
});

const writeKept = (standing: StandingOverrides) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (standing.tasks === null && standing.adhoc === null) {
      yield* fileSystem.remove(yield* filePath);
      return;
    }
    const tasks = storedForm(standing.tasks);
    const adhoc = storedForm(standing.adhoc);
    yield* fileSystem.writeFileString(
      yield* filePath,
      encodeStanding({
        ...(tasks === undefined ? {} : { tasks }),
        ...(adhoc === undefined ? {} : { adhoc }),
      } as typeof StoredStanding.Type),
    );
  });

/**
 * Remembers the override for the parts `scope` covers, so it also reaches
 * threads that were not open when it was set. The other part keeps its own.
 */
export const rememberStandingOverride = (override: ModelOverride, scope: ModelOverrideScope) =>
  Effect.gen(function* () {
    const current = (yield* readKept) ?? NO_STANDING_OVERRIDES;
    yield* writeKept(withScopedOverride(current, scope, override));
  }).pipe(Effect.ignore);

/** "Put back" ends the rule for the parts `scope` covers. */
export const forgetStandingOverride = (scope: ModelOverrideScope) =>
  Effect.gen(function* () {
    const current = (yield* readKept) ?? NO_STANDING_OVERRIDES;
    yield* writeKept(withScopedOverride(current, scope, null));
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
  Schema.Struct({
    previous: ModelSelection,
    applied: ModelSelection,
    /** The part the thread was counted in when the override reached it. */
    scope: Schema.optional(Schema.Literals(["tasks", "adhoc"])),
  }),
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

/**
 * Whether the user typed in a thread the override never moved after the
 * override was set: the model they wrote on is their pick for that thread,
 * so an automation must not move it either. A task the user created also
 * posts as "user", so only messages without a task count.
 */
export function userWroteSinceOverride(input: {
  readonly applied: ModelSelection | undefined;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "createdBy" | "scheduledTaskId" | "createdAt">
  >;
  readonly overrideSetAtMs: number | null;
}): boolean {
  const setAt = input.overrideSetAtMs;
  return (
    input.applied === undefined &&
    setAt !== null &&
    input.messages.some(
      (message) =>
        message.createdBy === "user" &&
        message.scheduledTaskId === undefined &&
        message.createdAt.epochMilliseconds > setAt,
    )
  );
}

/** The overrides in force for task threads and for the others. */
export const readStandingOverride = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const stored = yield* readKept;
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
  if (derived === null) return NO_STANDING_OVERRIDES;
  yield* rememberStandingOverride(derived, "all");
  return { tasks: derived, adhoc: derived };
}).pipe(Effect.orElseSucceed(() => NO_STANDING_OVERRIDES));

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
 * How the decision log names a selection. The thinking level is part of it: a thread on the
 * rule's model but another level differs from the rule, and the log must show where.
 */
export function describeSelection(selection: ModelSelection): string {
  const effort = selection.options?.find((option) => /effort/i.test(option.id))?.value;
  const base = `${selection.instanceId}/${selection.model}`;
  return effort === undefined ? base : `${base} (${String(effort)})`;
}

/**
 * Moving a thread to another instance while its run is under way detaches that
 * run's provider session and fails the turn (Alpha, 2026-10-21; upstream
 * #22748). Such a thread keeps its instance until the run ends: a client lines
 * its composer up from the reported selection, and automatic work aligns it
 * before its next start.
 */
export function switchWaitsForRun(input: {
  readonly activeRunId: string | null;
  readonly current: ModelSelection;
  readonly next: ModelSelection;
}): boolean {
  return input.activeRunId !== null && input.current.instanceId !== input.next.instanceId;
}

/**
 * What one alignment does. A thread already on the rule's model needs nothing,
 * whoever put it there; recording it as keeping its own choice would name a
 * difference that does not exist.
 */
export function standingAlignmentStep(input: {
  readonly next: ModelSelection | null;
  readonly current: ModelSelection;
  readonly keepsOwnChoice: boolean;
}): "none" | "kept-own-choice" | "align" {
  if (input.next !== null && modelSelectionsEqual(input.next, input.current)) return "none";
  if (input.keepsOwnChoice) return "kept-own-choice";
  return input.next === null ? "none" : "align";
}

/**
 * Brings one thread in line with the standing override of its part before it
 * gets work that does not come from the user. `messageScope` is the part the
 * incoming message speaks for: "tasks" for a scheduled task's message. A thread
 * the override already reached stays in the part it was counted in then, so a
 * task thread that gets another automatic message does not swap models. Never
 * fails: a thread that cannot be aligned simply runs on what it has.
 */
export const alignThreadWithStandingOverride = (
  threads: Pick<
    ThreadManagement.ThreadManagementServiceShape,
    "getThreadShell" | "getThreadRecords" | "dispatch"
  >,
  threadId: Parameters<ThreadManagement.ThreadManagementServiceShape["getThreadShell"]>[0],
  reason: string,
  messageScope: ThreadScope,
) =>
  Effect.gen(function* () {
    const standing = yield* readStandingOverride;
    if (standing.tasks === null && standing.adhoc === null) return;
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
    const scope = saved[threadId]?.scope ?? messageScope;
    const override = standing[scope];
    if (override === null) return;
    // The rule file is written only when the rule is set or put back, so its
    // modification time is when the rule began to stand.
    const overrideSetAtMs = yield* fileSystem.stat(yield* filePath).pipe(
      Effect.map((info) => Option.getOrNull(Option.map(info.mtime, (mtime) => mtime.getTime()))),
      Effect.orElseSucceed(() => null),
    );
    // The shell's latest "user" message also counts tasks the user created;
    // read the messages only when it says someone wrote after the rule.
    const maybeWroteSince =
      saved[threadId] === undefined &&
      overrideSetAtMs !== null &&
      thread.latestUserAuthoredMessageAt != null &&
      thread.latestUserAuthoredMessageAt.epochMilliseconds > overrideSetAtMs;
    const userMessages = maybeWroteSince
      ? yield* threads.getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] }).pipe(
          Effect.map((records) => records.messages),
          Effect.orElseSucceed(() => []),
        )
      : [];
    const next = standingSelectionFor({
      override,
      thread,
      providers: yield* registry.value.getProviders,
    });
    const step = standingAlignmentStep({
      next,
      current: thread.modelSelection,
      keepsOwnChoice:
        userChoseOtherModel(saved[threadId]?.applied, thread.modelSelection) ||
        userWroteSinceOverride({
          applied: saved[threadId]?.applied,
          messages: userMessages,
          overrideSetAtMs,
        }),
    });
    if (step === "none" || next === null) return;
    if (
      step === "align" &&
      switchWaitsForRun({
        activeRunId: thread.activeRunId,
        current: thread.modelSelection,
        next,
      })
    )
      return;
    if (step === "kept-own-choice") {
      const current = describeSelection(thread.modelSelection);
      // A task on a timer comes by every few minutes; the same choice is recorded once.
      const key = `${threadId}\0${current}`;
      if (!keptChoicesRecorded.has(key)) {
        keptChoicesRecorded.add(key);
        yield* recordDecision({
          kind: "model-override-applied",
          threadId,
          outcome: "kept-own-choice",
          facts: { reason, current, scope },
        });
      }
      return;
    }
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
            scope,
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
        from: describeSelection(thread.modelSelection),
        to: describeSelection(next),
        scope,
      },
    });
  }).pipe(Effect.ignore);
