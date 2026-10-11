/**
 * Decides whether a thread-bound task that runs "when the thread is idle"
 * should fire now.
 *
 * Idle is judged against the server's own view of the thread at decision time.
 * A client's snapshot saying "idle" can be stale by the time it acts, and a
 * prompt sent into a thread that just started work would queue behind it.
 *
 * @module idleTrigger
 */
import type { OrchestrationV2ThreadShell, ScheduledTaskIdleSchedule } from "@t3tools/contracts";

export type IdleTriggerThread = Pick<
  OrchestrationV2ThreadShell,
  "activeRunId" | "activityRunStatus" | "pendingRuntimeRequest" | "latestRunCompletedAt"
>;

export type IdleTriggerDecision =
  /** Start the task's prompt now. */
  | { readonly type: "fire" }
  /** Nothing to do yet; `reason` is for logs and tests. */
  | {
      readonly type: "wait";
      readonly reason: "busy" | "waiting-on-user" | "no-finished-run" | "pause";
    }
  /** The task has used up its runs and should be turned off. */
  | { readonly type: "exhausted" };

/**
 * `armedAtMs` is when the task was last enabled or edited: a run that ended
 * before that does not count, so arming a task on a thread that has been
 * quiet for a day does not fire it at once. `lastRunAtMs` is the task's own
 * last start, which the minimum pause is measured from.
 */
export function decideIdleTrigger(input: {
  readonly schedule: ScheduledTaskIdleSchedule;
  readonly thread: IdleTriggerThread;
  readonly runCount: number;
  readonly armedAtMs: number;
  readonly lastRunAtMs: number | null;
  readonly nowMs: number;
}): IdleTriggerDecision {
  const { schedule, thread } = input;
  if (input.runCount >= schedule.maxRuns) return { type: "exhausted" };
  if (thread.activeRunId !== null || (thread.activityRunStatus ?? null) !== null) {
    return { type: "wait", reason: "busy" };
  }
  // An agent waiting for an approval or an answer needs the user, not a nudge.
  if (thread.pendingRuntimeRequest !== null) return { type: "wait", reason: "waiting-on-user" };
  const completedAtMs =
    thread.latestRunCompletedAt == null ? null : thread.latestRunCompletedAt.epochMilliseconds;
  if (completedAtMs === null || completedAtMs < input.armedAtMs) {
    return { type: "wait", reason: "no-finished-run" };
  }
  const pauseFromMs = Math.max(completedAtMs, input.lastRunAtMs ?? 0);
  if (input.nowMs - pauseFromMs < schedule.minPauseMs) return { type: "wait", reason: "pause" };
  return { type: "fire" };
}
