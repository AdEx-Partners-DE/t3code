/** Retries transient start failures once, before the turn produced a response. */
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  CommandId,
  MessageId,
  ServerDrainError,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { recordDecision } from "../decisionLog.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorkAdmission from "./WorkAdmission.ts";

/** A turn that ran longer than this did real work; its failure is not a start failure. */
export const INSTANT_FAILURE_WINDOW_MS = 15_000;

const RETRY_MESSAGE_PREFIX = "message:instant-retry:";
const isServerDrainError = Schema.is(ServerDrainError);

function isAdmissionClosed(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (Predicate.isObject(error) && !seen.has(error)) {
    if (isServerDrainError(error)) return error.reason === "admission_closed";
    seen.add(error);
    if (!("cause" in error)) return false;
    error = error.cause;
  }
  return false;
}

/**
 * Provider errors carry no finer class, so the two start failures seen in
 * practice are recognised by their text: a session that did not open and a
 * provider process that exited.
 */
export function isTransientStartFailure(
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "message">,
): boolean {
  if (failure.class === "transport_error") return true;
  if (failure.class !== "provider_error") return false;
  return /failed to open .*provider session|process exited/i.test(failure.message);
}

/**
 * A turn that could not start because the thread had just been moved to
 * another account or provider and its history does not fit the handoff. The
 * same message on the same account fails again, but the account the thread
 * was on still has the conversation.
 */
export function isHandoffBudgetFailure(
  failure: Pick<OrchestrationV2ProviderFailure, "message">,
): boolean {
  return /Insufficient context allowance for the provider handoff/i.test(failure.message);
}

/**
 * Where a thread worked before it was moved: the selection of its last
 * finished run on another provider instance than the failed run's.
 */
export function selectionBeforeMove(
  runs: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadProjection["runs"][number],
      "id" | "ordinal" | "status" | "providerInstanceId" | "modelSelection"
    >
  >,
  failedRunId: RunId,
): OrchestrationV2ThreadProjection["runs"][number]["modelSelection"] | null {
  const failed = runs.find((candidate) => candidate.id === failedRunId);
  if (failed === undefined) return null;
  const last = runs
    .filter((candidate) => candidate.ordinal < failed.ordinal && candidate.status === "completed")
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .at(-1);
  return last === undefined || last.providerInstanceId === failed.providerInstanceId
    ? null
    : last.modelSelection;
}

/**
 * The message to send again for `failedRunId`, or null when the run is not a
 * start failure worth retrying. With `backTo`, a turn that failed on the
 * handoff is sent again on the account the thread came from. `projection` needs the thread's runs, the
 * failed run's messages and its error items.
 */
export function instantFailureRetryCommand(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages" | "turnItems">,
  failedRunId: RunId,
  backTo: OrchestrationV2ThreadProjection["runs"][number]["modelSelection"] | null = null,
): OrchestrationV2Command | null {
  const { thread } = projection;
  if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
  const run = projection.runs.find((candidate) => candidate.id === failedRunId);
  if (run === undefined || run.status !== "failed" || run.completedAt === null) return null;
  if (thread.providerInstanceId !== run.providerInstanceId) return null;
  const startedAt = run.startedAt ?? run.requestedAt;
  if (
    DateTime.toEpochMillis(run.completedAt) - DateTime.toEpochMillis(startedAt) >
    INSTANT_FAILURE_WINDOW_MS
  )
    return null;
  // Anything the user or an agent started since then takes precedence.
  if (
    projection.runs.some(
      (other) => other.id !== run.id && other.status !== "queued" && runRanAfter(other, run),
    )
  )
    return null;
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  if (message === undefined || message.role !== "user") return null;
  // One retry only: a retry that fails as well is reported.
  if (message.id.startsWith(RETRY_MESSAGE_PREFIX)) return null;
  // Results of delegated tasks have their own delivery bookkeeping.
  if (message.delegatedCompletion !== undefined) return null;
  if (isNativeMaintenanceCommand(message)) return null;
  // The turn said something before it failed: it did start.
  if (
    projection.messages.some(
      (candidate) =>
        candidate.runId === run.id &&
        candidate.role === "assistant" &&
        candidate.text.trim() !== "",
    )
  )
    return null;
  const failures = projection.turnItems.flatMap((item) =>
    item.type === "error" && item.runId === run.id ? [item.failure] : [],
  );
  if (failures.length === 0) return null;
  const backToPrevious = backTo !== null && failures.every(isHandoffBudgetFailure);
  if (!backToPrevious && !failures.every(isTransientStartFailure)) return null;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`command:instant-retry:${run.id}`),
    threadId: thread.id,
    messageId: MessageId.make(`${RETRY_MESSAGE_PREFIX}${run.id}`),
    text: message.text,
    ...(message.context === undefined ? {} : { context: message.context }),
    attachments: message.attachments,
    ...(message.scheduledTaskId === undefined ? {} : { scheduledTaskId: message.scheduledTaskId }),
    // Shown as a work log row; the prompt the agent got is its detail.
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: backToPrevious
        ? "This thread's history does not fit a move to another account; the turn was sent again on the account it came from"
        : "The turn failed to start and was sent again",
      detail: message.text,
    },
    modelSelection: backToPrevious ? backTo : run.modelSelection,
    // A server notice may only be queued; in a thread whose turn just failed
    // nothing is running, so it starts at once.
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  };
}

/**
 * Watches for failed runs and sends the retry. Reads the setting at the moment
 * of the failure, so turning it off takes effect at once.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const admission = yield* WorkAdmission.WorkAdmission;
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const retry = Effect.fn("InstantFailureRetry.retry")(function* (input: {
      readonly threadId: OrchestrationV2ThreadProjection["thread"]["id"];
      readonly runId: RunId;
    }) {
      const enabled = yield* settings.getSettings.pipe(
        Effect.map((value) => value.retryInstantFailures),
        Effect.orElseSucceed(() => false),
      );
      if (!enabled) return;
      const projection = yield* threads.getThreadRecords(
        input.threadId,
        ["runs", "messages", "turnItems"],
        { messageRunIds: [input.runId], turnItemRunIds: [input.runId], turnItemTypes: ["error"] },
      );
      const before = selectionBeforeMove(projection.runs, input.runId);
      // Back on the old account, but on the model the thread was moved to
      // when that account has it: the move was about the model.
      const failed = projection.runs.find((candidate) => candidate.id === input.runId);
      const providers = Option.isNone(registry) ? [] : yield* registry.value.getProviders;
      const backTo =
        before !== null &&
        failed !== undefined &&
        providers
          .find((provider) => provider.instanceId === before.instanceId)
          ?.models.some((model) => model.slug === failed.modelSelection.model)
          ? { ...failed.modelSelection, instanceId: before.instanceId }
          : before;
      const command = instantFailureRetryCommand(projection, input.runId, backTo);
      const wentBack =
        command !== null &&
        command.type === "message.dispatch" &&
        backTo !== null &&
        command.modelSelection === backTo;
      if (command !== null) {
        yield* threads.dispatch(command);
        yield* Effect.logInfo("Retried a turn that failed to start", input);
      }
      yield* recordDecision({
        kind: "start-failure-retry",
        threadId: input.threadId,
        outcome:
          command === null ? "not-retried" : wentBack ? "retried-on-previous-account" : "retried",
        facts: {
          runId: input.runId,
          ...(wentBack ? { backTo: `${backTo.instanceId}/${backTo.model}` } : {}),
          failures: projection.turnItems.flatMap((item) =>
            item.type === "error"
              ? [`${item.failure.class}: ${item.failure.message.slice(0, 160)}`]
              : [],
          ),
        },
      });
    });
    // Admission can block this consumer, so exclude turn-item payloads before buffering.
    const runUpdates = Stream.unwrap(
      sink
        .latestSequence()
        .pipe(
          Effect.map((afterSequence) => sink.stream({ afterSequence, eventType: "run.updated" })),
        ),
    ).pipe(Stream.map((stored) => stored.event));
    yield* Stream.runForEach(runUpdates, (event) =>
      event.type === "run.updated" && event.payload.status === "failed"
        ? retry({ threadId: event.threadId, runId: event.payload.id }).pipe(
            // Admission may close again after reopening; re-read the setting and
            // thread before retrying the same idempotent command.
            Effect.retry({
              while: (error) =>
                isAdmissionClosed(error) ? admission.awaitOpen.pipe(Effect.as(true)) : false,
            }),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not retry a turn that failed to start", {
                threadId: event.threadId,
                cause,
              }),
            ),
          )
        : Effect.void,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Instant failure retry stopped watching runs", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provide(WorkAdmission.layer));
