/**
 * Retries a turn once when it failed before it really started.
 *
 * Most failed turns die in their first seconds on something that is gone a
 * moment later: the provider session did not open, the provider process
 * exited, the connection dropped. Nothing was produced, so sending the same
 * message again loses nothing. Failures that will repeat (a usage limit, a
 * missing sign-in, a rejected request) are left alone.
 *
 * @module InstantFailureRetry
 */
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** A turn that ran longer than this did real work; its failure is not a start failure. */
export const INSTANT_FAILURE_WINDOW_MS = 15_000;

const RETRY_MESSAGE_PREFIX = "message:instant-retry:";

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
 * The message to send again for `failedRunId`, or null when the run is not a
 * start failure worth retrying. `projection` needs the thread's runs, the
 * failed run's messages and its error items.
 */
export function instantFailureRetryCommand(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages" | "turnItems">,
  failedRunId: RunId,
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
  if (failures.length === 0 || !failures.every(isTransientStartFailure)) return null;
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
      summary: "The turn failed to start and was sent again",
      detail: message.text,
    },
    modelSelection: run.modelSelection,
    dispatchMode: { type: "start_immediately" },
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
    const settings = yield* ServerSettings.ServerSettingsService;
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
      const command = instantFailureRetryCommand(projection, input.runId);
      if (command === null) return;
      yield* Effect.logInfo("Retrying a turn that failed to start", input);
      yield* threads.dispatch(command);
    });
    yield* Stream.runForEach(threads.streamDomainEvents, (event) =>
      event.type === "run.updated" && event.payload.status === "failed"
        ? retry({ threadId: event.threadId, runId: event.payload.id }).pipe(
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
);
