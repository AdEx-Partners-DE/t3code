/**
 * Sends one message to every open thread that stands still, so work goes on
 * in all of them without the user visiting each.
 *
 * A thread that is working, waits on an answer, failed or is snoozed is left
 * alone: a nudge would queue behind the work, bury the question, or run into
 * the same failure.
 *
 * @module OpenThreadNudge
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { isOpenThread } from "./OpenThreadModelOverride.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

type NudgeThread = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "archivedAt"
  | "settledAt"
  | "settledOverride"
  | "lineage"
  | "activeRunId"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "status"
  | "snoozedUntil"
  | "latestRunId"
  | "latestRunCompletedAt"
>;

/** Whether the thread has done a turn and now waits for the next message. */
export function standsStill(thread: NudgeThread, nowMs: number): boolean {
  return (
    isOpenThread(thread) &&
    thread.latestRunId !== null &&
    thread.activeRunId === null &&
    (thread.activityRunStatus ?? null) === null &&
    thread.pendingRuntimeRequest === null &&
    (thread.status === "idle" ||
      thread.status === "completed" ||
      thread.status === "cancelled" ||
      thread.status === "interrupted") &&
    (thread.snoozedUntil == null || DateTime.toEpochMillis(thread.snoozedUntil) <= nowMs)
  );
}

/**
 * The threads a nudge goes to: those standing still, most recently finished
 * first, cut at `limit` so one click cannot start every thread at once.
 */
export function nudgeTargets<T extends NudgeThread>(
  threads: ReadonlyArray<T>,
  nowMs: number,
  limit: number,
): { readonly targets: ReadonlyArray<T>; readonly still: number } {
  const finishedAt = (thread: T) =>
    thread.latestRunCompletedAt == null ? 0 : DateTime.toEpochMillis(thread.latestRunCompletedAt);
  const still = threads
    .filter((thread) => standsStill(thread, nowMs))
    .toSorted((left, right) => finishedAt(right) - finishedAt(left));
  return { targets: still.slice(0, Math.max(0, limit)), still: still.length };
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return {
    /**
     * Starts a turn with `text` in up to `limit` threads that stand still.
     * `sent` is how many started, `still` how many stood still in all.
     */
    send: Effect.fn("OpenThreadNudge.send")(function* (input: {
      readonly commandId: CommandId;
      readonly text: string;
      readonly limit: number;
    }) {
      const shell = yield* threads.getShellSnapshot();
      const { targets, still } = nudgeTargets(
        shell.threads,
        yield* Clock.currentTimeMillis,
        input.limit,
      );
      let sent = 0;
      for (const thread of targets) {
        const threadId: ThreadId = thread.id;
        const started = yield* threads
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${input.commandId}:nudge:${threadId}`),
            threadId,
            messageId: MessageId.make(`message:nudge:${input.commandId}:${threadId}`),
            text: input.text,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.logWarning("Could not nudge a thread", { threadId, cause }).pipe(
                Effect.as(false),
              ),
            ),
          );
        if (started) sent += 1;
      }
      yield* Effect.logInfo("Open threads nudged", { sent, still });
      return { sent, still };
    }),
  };
});
