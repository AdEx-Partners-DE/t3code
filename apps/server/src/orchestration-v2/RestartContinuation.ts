import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  latestProviderTurnForAttempt,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  awaitingProviderThreadId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  isAwaitedWork,
  isRestartContinuationSource,
  cancelledBeforeStart,
  isRestartNoteSource,
  isWorktreeContinuationRun,
  neverStarted,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
  restartPromptSource,
} from "./RestartBackgroundNote.ts";

const CONTINUE_PROMPT = "Continue where you left off.";

/**
 * Whether a restart must leave this run for the user: the thread is put away,
 * the provider turn already ended, or the user owes an answer. Checked when
 * intent is recorded and again when the continuation is delivered. A
 * `settled` run is woken for the awaited work it lost, so its ended provider
 * turn does not block it.
 */
export function restartContinuationBlocked(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runtimeRequests" | "providerTurns" | "turnItems"
  >,
  source: OrchestrationV2Run,
  now: DateTime.Utc,
  settled: boolean,
): boolean {
  // An elapsed snooze no longer holds the thread. The early wakes the settlement
  // service counts (a run that completed or failed after the snooze) cannot
  // apply here: the source is the latest run and it was cut, not finished.
  if (
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null ||
    projection.thread.settledOverride === "settled" ||
    (projection.thread.snoozedUntil != null &&
      DateTime.isGreaterThan(projection.thread.snoozedUntil, now))
  )
    return true;
  const turn = latestProviderTurnForAttempt(projection.providerTurns, source.activeAttemptId);
  return (
    (!settled &&
      turn !== undefined &&
      (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")) ||
    projection.runtimeRequests.some(
      (request) =>
        // Tool calls and auth refreshes do not wait on a person, and a
        // message-capable question stays answerable after the restart.
        request.kind !== "dynamic_tool_call" &&
        request.kind !== "auth_refresh" &&
        request.responseCapability.type !== "message" &&
        (request.status === "pending" ||
          // Recovery closes live callbacks; it does not answer their question.
          ((request.status === "expired" || request.status === "cancelled") &&
            request.responseCapability.type === "not_resumable" &&
            source.activeAttemptId !== null &&
            projection.providerTurns.some(
              (turn) =>
                turn.id === request.providerTurnId && turn.runAttemptId === source.activeAttemptId,
            ))),
    ) ||
    projection.turnItems.some(
      (item) =>
        item.type === "secret_request" &&
        item.runId === source.id &&
        (item.secretStatus === "pending" ||
          (item.secretStatus === "cancelled" &&
            item.completedAt !== null &&
            source.completedAt !== null &&
            DateTime.Order(item.completedAt, source.completedAt) === 0)),
    )
  );
}

/**
 * App-owned delegations are not counted: their own threads continue and report
 * back.
 */
function hasOpenAwaitedWork(
  projection: Pick<ProjectionRuntimeRecoveryState, "runs" | "turnItems">,
  providerThread: ProjectionRuntimeRecoveryState["providerThreads"][number],
): boolean {
  const openItem = projection.turnItems.some((item) => {
    if (item.status !== "pending" && item.status !== "running" && item.status !== "waiting")
      return false;
    if (item.type === "subagent" && item.origin === "app_owned" && item.childThreadId !== null)
      return false;
    const work = cancelledTurnItemWork(item);
    return (
      work !== undefined &&
      isAwaitedWork(work) &&
      awaitingProviderThreadId(item, projection.runs) === providerThread.id
    );
  });
  return (
    openItem ||
    (providerThread.ownerNodeId === null &&
      (providerThread.pendingBackgroundTasks ?? []).some((task) =>
        isAwaitedWork(cancelledRosterTaskWork(task)),
      ))
  );
}

/**
 * A settled run needs a live session, so stale records from an older crash
 * never wake it.
 */
export function restartContinuationRun(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    | "thread"
    | "runs"
    | "attempts"
    | "providerThreads"
    | "providerSessions"
    | "providerTurns"
    | "runtimeRequests"
    | "turnItems"
  >,
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.status !== "queued" &&
      !neverStarted(candidate) &&
      (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  if (!run) return;
  const preparedContinuation =
    run.status === "starting" &&
    (run.restartContinuationOfRunId !== undefined ||
      restartPromptSource(run, projection.runs, projection.providerTurns, projection.attempts) !==
        undefined);
  const settled = run.status === "completed" || run.status === "waiting";
  if (run.status !== "running" && !preparedContinuation && !settled) return;
  if (restartContinuationBlocked(projection, run, now, settled)) return;
  const liveTurnRequired = !preparedContinuation && !settled;
  if (projection.thread.providerInstanceId !== run.providerInstanceId) return;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (
    !providerThread ||
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.ownerNodeId !== null ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== providerThread.driver ||
    (liveTurnRequired && providerThread.status !== "active") ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  // Most adapters keep a live session "ready" through its turns, so only a
  // stopped or failed session rules out a live turn.
  if (
    session === undefined ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver ||
    (!preparedContinuation && (session.status === "stopped" || session.status === "error"))
  )
    return;
  if (settled) return hasOpenAwaitedWork(projection, providerThread) ? run : undefined;
  // A run cut before its provider turn began never reached the provider; its
  // continuation sends the original message again (see restartPromptSource).
  if (
    liveTurnRequired &&
    restartPromptSource(run, projection.runs, projection.providerTurns, projection.attempts) ===
      undefined &&
    !projection.providerTurns.some(
      (turn) =>
        turn.providerThreadId === providerThread.id &&
        turn.runAttemptId === run.activeAttemptId &&
        turn.status === "running",
    )
  )
    return;
  return run;
}

/** Consecutive automatic continuations allowed before a person has to step in. */
const MAX_CONTINUATION_CHAIN = 3;
const CONTINUATION_LOOP_WINDOW_MS = 5 * 60 * 1_000;

export const continueRestartedRun = Effect.fn("RestartContinuation.continueRestartedRun")(
  function* (input: { readonly threadId: ThreadId; readonly sourceRunId: RunId }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const messageId = MessageId.make(`message:restart-continuation:${input.sourceRunId}`);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "providerTurns", "attempts", "runtimeRequests", "turnItems"],
      { messageIds: [messageId], turnItemTypes: ["secret_request"] },
    );
    if (
      !resolveProjectSettings(enabled, projection.thread.projectId).settings
        .continueThreadsAfterServerUpdate
    )
      return;
    if (projection.messages.some((message) => message.id === messageId)) return;
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    const worktreeContinuation =
      source !== undefined &&
      source.status === "queued" &&
      source.queueHeld !== true &&
      isWorktreeContinuationRun(source) &&
      projection.thread.worktreePath != null &&
      projection.runs.filter((run) => run.status === "queued").length === 1 &&
      !projection.runs.some((run) =>
        ["preparing", "starting", "running", "waiting"].includes(run.status),
      );
    // Reconciliation cancels a waiting run it cannot checkpoint, so a settled
    // source can be cancelled too. It continues only for awaited work.
    if (
      !source ||
      (!isRestartContinuationSource(source, projection.providerTurns) && !worktreeContinuation) ||
      (isWorktreeContinuationRun(source) &&
        source.status === "cancelled" &&
        !projection.providerTurns.some((turn) => turn.runAttemptId === source.activeAttemptId)) ||
      restartContinuationBlocked(
        projection,
        source,
        yield* DateTime.now,
        isRestartNoteSource(source, projection.providerTurns),
      )
    )
      return;
    if (
      projection.runs.some(
        (run) =>
          run.id !== source.id &&
          run.status !== "queued" &&
          !cancelledBeforeStart(run) &&
          (worktreeContinuation ? run.ordinal > source.ordinal : runRanAfter(run, source)),
      )
    )
      return;
    if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
    // A turn that keeps crashing the server would otherwise restart it forever.
    let chainLength = 0;
    const loopWindowStart =
      DateTime.toEpochMillis(source.completedAt ?? source.requestedAt) -
      CONTINUATION_LOOP_WINDOW_MS;
    for (
      let run: (typeof projection.runs)[number] | undefined = source;
      run?.restartContinuationOfRunId !== undefined && chainLength < MAX_CONTINUATION_CHAIN;
      run = projection.runs.find((candidate) => candidate.id === run?.restartContinuationOfRunId)
    ) {
      if (DateTime.toEpochMillis(run.requestedAt) < loopWindowStart) break;
      chainLength += 1;
    }
    if (chainLength >= MAX_CONTINUATION_CHAIN) {
      yield* Effect.logWarning("Not continuing a run restarted too many times in a row", {
        threadId: input.threadId,
        sourceRunId: input.sourceRunId,
      });
      return;
    }
    const promptSource = restartPromptSource(
      source,
      projection.runs,
      projection.providerTurns,
      projection.attempts,
    );
    const sourceRecords = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "turnItems"],
      {
        messageIds: [source.userMessageId, ...(promptSource ? [promptSource.userMessageId] : [])],
        turnItemRunIds: [source.id],
        turnItemTypes: ["run_interrupt_request"],
      },
    );
    if (
      sourceRecords.turnItems.some(
        (item) => item.runId === source.id && item.type === "run_interrupt_request",
      )
    )
      return;
    const sourceMessage = sourceRecords.messages.find(
      (message) => message.id === source.userMessageId,
    );
    if (sourceMessage !== undefined && isNativeMaintenanceCommand(sourceMessage)) return;
    const replacementMessage =
      promptSource === undefined
        ? undefined
        : sourceRecords.messages.find((message) => message.id === promptSource.userMessageId);
    if (promptSource !== undefined && replacementMessage === undefined) return;
    const prompt = replacementMessage?.text ?? CONTINUE_PROMPT;
    const note = restartContinuationNote(
      source,
      projection.runs,
      projection.providerTurns,
      projection.attempts,
    );
    const noteText =
      note.work.length === 0 ? undefined : restartCancelledBackgroundWorkNote(note.work);
    const text =
      noteText === undefined ? prompt : note.settled ? noteText : `${noteText}\n\n${prompt}`;
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
        threadId: input.threadId,
        messageId,
        ...(sourceMessage?.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: sourceMessage.scheduledTaskId }),
        text,
        // Shown as a work log row; the prompt the agent got is its detail. A
        // replacement prompt keeps its own message, attachments and context.
        ...(replacementMessage === undefined
          ? {
              notification: {
                source: { kind: "system" as const },
                outcome: "updated" as const,
                summary: note.settled
                  ? "T3 Code restarted and stopped background work"
                  : "T3 Code restarted and resumed this turn",
                detail: text,
              },
            }
          : {}),
        attachments: replacementMessage?.attachments ?? [],
        ...(replacementMessage?.context === undefined
          ? {}
          : { context: replacementMessage.context }),
        modelSelection: source.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: input.sourceRunId,
      })
      .pipe(
        // The project turned this instance off since the restart. No turn
        // resumes, and the success path below still runs so a delegated
        // child waiting on this run is recovered immediately instead of
        // after EffectWorker exhausts its retries on a refusal that will
        // not change.
        Effect.catchTags({
          ThreadManagementProviderInstanceDisabledError: (error) =>
            Effect.logInfo("orchestration-v2.restart-continuation.instance-disabled", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
              projectId: error.projectId,
              instanceId: error.instanceId,
            }),
        }),
      );
  },
  // A delegated child this declined to continue still owes its parent a
  // result. Once a continuation run exists this is a no-op; that run settles it.
  (effect, input) =>
    effect.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
        }),
      ),
    ),
);
