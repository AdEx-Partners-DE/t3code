/**
 * Picks the threads a portfolio task nudges in one pass.
 *
 * A portfolio task is an idle task for every open thread at once: it sends its
 * prompt to each thread that stands still, so work goes on everywhere without
 * one automation per thread. Three brakes keep that from running away: a cap
 * on how many threads may work at the same time, a pause after each thread's
 * own run, and never the same finished run twice.
 *
 * @module portfolioNudge
 */
import type { OrchestrationV2ThreadShell, ScheduledTaskIdleSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { standsStill } from "../orchestration-v2/OpenThreadNudge.ts";
import { isOpenThread } from "../orchestration-v2/OpenThreadModelOverride.ts";

type PortfolioThread = Parameters<typeof standsStill>[0] &
  Pick<OrchestrationV2ThreadShell, "modelSelection">;

export const DEFAULT_MAX_PARALLEL = 2;
/**
 * How often a supervised task sends one thread on. A supervisor and an agent
 * that keep answering each other would otherwise go round in circles.
 */
export const MAX_SUPERVISED_SENDS_PER_THREAD = 2;

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
    "maxRuns" | "runsUsed" | "minPauseMs" | "maxParallel" | "nudged"
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
  const targets = open
    .filter(
      (thread) =>
        standsStill(thread, input.nowMs) &&
        remembered[thread.id] !== thread.latestRunId &&
        input.nowMs - finishedAt(thread) >= schedule.minPauseMs,
    )
    .toSorted((left, right) => finishedAt(right) - finishedAt(left))
    .slice(0, slots);
  return { targets, working, remembered };
}
