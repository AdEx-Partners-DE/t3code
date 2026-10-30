/**
 * Picks the threads a portfolio task nudges in one pass. Brakes: a cap on threads
 * working at once, a pause after each thread's own run, never the same finished run twice.
 */
import type { OrchestrationV2ThreadShell, ScheduledTaskIdleSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { standsStill } from "../orchestration-v2/OpenThreadNudge.ts";
import { isOpenThread } from "../orchestration-v2/OpenThreadModelOverride.ts";

type PortfolioThread = Parameters<typeof standsStill>[0] &
  Pick<OrchestrationV2ThreadShell, "modelSelection">;

const DEFAULT_MAX_PARALLEL = 2;
/**
 * How often a supervised task sends one thread on. A supervisor and an agent
 * that keep answering each other would otherwise go round in circles.
 */
export const MAX_SUPERVISED_SENDS_PER_THREAD = 2;

/**
 * How often a supervised task has sent a thread on since its user last wrote
 * in it. A message from the user starts the count again: they have seen the
 * thread, so the next stop is a new one.
 */
export function supervisedSendsSinceUser(input: {
  readonly sends: number | undefined;
  readonly lastSentAt: string | undefined;
  readonly userWroteAtMs: number | null;
}): number {
  const sends = input.sends ?? 0;
  if (sends === 0 || input.userWroteAtMs === null || input.lastSentAt === undefined) return sends;
  const lastSentAtMs = Date.parse(input.lastSentAt);
  return Number.isFinite(lastSentAtMs) && input.userWroteAtMs > lastSentAtMs ? 0 : sends;
}

export interface PortfolioNudgePlan<T> {
  /** Threads to send to now, most recently finished first. */
  readonly targets: ReadonlyArray<T>;
  /** Open threads with a run under way, counted against the cap. */
  readonly working: number;
  /** `nudged` without threads that are no longer open. */
  readonly remembered: Readonly<Record<string, string>>;
}

/**
 * `nudged` maps a thread to the run this task last reacted to: a thread is
 * sent to again only after it has finished another run. The caller still
 * checks each target's last reply for the stop phrase and its account for the
 * budget, since both need I/O.
 */
export function planPortfolioNudge<T extends PortfolioThread>(input: {
  readonly schedule: Pick<
    ScheduledTaskIdleSchedule,
    "maxRuns" | "runsUsed" | "minPauseMs" | "maxParallel" | "nudged" | "excludeThreadIds"
  >;
  readonly threads: ReadonlyArray<T>;
  readonly nowMs: number;
}): PortfolioNudgePlan<T> {
  const { schedule } = input;
  const open = input.threads.filter(isOpenThread);
  const openIds = new Set(open.map((thread) => thread.id as string));
  const remembered = Object.fromEntries(
    Object.entries(schedule.nudged ?? {}).filter(([threadId]) => openIds.has(threadId)),
  );
  const working = open.filter(
    (thread) => thread.activeRunId !== null || (thread.activityRunStatus ?? null) !== null,
  ).length;
  const runsLeft = schedule.maxRuns - (schedule.runsUsed ?? 0);
  const slots = Math.min(runsLeft, (schedule.maxParallel ?? DEFAULT_MAX_PARALLEL) - working);
  if (slots <= 0) return { targets: [], working, remembered };
  const finishedAt = (thread: T) =>
    thread.latestRunCompletedAt == null ? 0 : DateTime.toEpochMillis(thread.latestRunCompletedAt);
  // Left out threads still count as working: the cap is about the machine,
  // not about who the task may write to.
  const excluded = new Set<string>(schedule.excludeThreadIds ?? []);
  const targets = open
    .filter(
      (thread) =>
        !excluded.has(thread.id) &&
        standsStill(thread, input.nowMs) &&
        remembered[thread.id] !== thread.latestRunId &&
        input.nowMs - finishedAt(thread) >= schedule.minPauseMs,
    )
    .toSorted((left, right) => finishedAt(right) - finishedAt(left))
    .slice(0, slots);
  return { targets, working, remembered };
}
