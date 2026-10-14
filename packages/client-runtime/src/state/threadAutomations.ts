import { taskRunsOnItsOwn, type ScheduledTask } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

/** Why a task that is not bound to a thread still shows in that thread's panel. */
export type ThreadAutomationReason = "covers-open-threads" | "waits-for-thread" | "running";

export interface RelatedThreadAutomation {
  readonly task: ScheduledTask;
  readonly reason: ThreadAutomationReason;
}

type ThreadForAutomations = Pick<
  EnvironmentThreadShell,
  "id" | "projectId" | "archivedAt" | "settledAt" | "settledOverride" | "lineage"
>;

/** Mirrors the server's `isOpenThread`: the threads an all-open-threads task sends to. */
function isOpenThread(thread: ThreadForAutomations): boolean {
  return (
    thread.lineage.relationshipToParent !== "subagent" &&
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    (thread.settledAt === null || thread.settledOverride === "active")
  );
}

function reasonFor(
  task: ScheduledTask,
  thread: ThreadForAutomations | null,
): ThreadAutomationReason | null {
  const schedule = task.schedule;
  if (thread !== null && task.enabled && schedule.type === "idle") {
    if (schedule.watchThreadId === thread.id) return "waits-for-thread";
    if (
      schedule.allOpenThreads === true &&
      isOpenThread(thread) &&
      (schedule.projectOnly !== true || task.projectId === thread.projectId) &&
      !(schedule.excludeThreadIds ?? []).includes(thread.id)
    ) {
      return "covers-open-threads";
    }
  }
  return task.lastRunStatus === "running" ? "running" : null;
}

/**
 * Tasks a thread's panel lists besides the ones bound to it: those that send
 * to this thread or wait for it, then any task running right now elsewhere.
 */
export function relatedThreadAutomations(input: {
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly threadId: string;
  readonly thread: ThreadForAutomations | null;
}): ReadonlyArray<RelatedThreadAutomation> {
  const related: RelatedThreadAutomation[] = [];
  for (const task of input.tasks) {
    if (task.threadId === input.threadId) continue;
    const reason = reasonFor(task, input.thread);
    if (reason !== null) related.push({ task, reason });
  }
  return related.sort(
    (left, right) => Number(left.reason === "running") - Number(right.reason === "running"),
  );
}

export interface AutomationsSummary {
  /** Tasks that start by themselves: switched on and not held by "Pause all tasks". */
  readonly onCount: number;
  /** Switched on, but held by "Pause all tasks". */
  readonly heldCount: number;
  readonly runningCount: number;
  /** The task that starts next on its own, or null when none has a time. */
  readonly next: ScheduledTask | null;
}

export function summarizeAutomations(input: {
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly paused: boolean;
  readonly exemptIds: ReadonlyArray<string>;
}): AutomationsSummary {
  const on = input.tasks.filter((task) => taskRunsOnItsOwn(task, input.paused, input.exemptIds));
  const next =
    on
      .filter((task) => task.nextRunAt !== null)
      .sort((left, right) => Date.parse(left.nextRunAt!) - Date.parse(right.nextRunAt!))[0] ?? null;
  return {
    onCount: on.length,
    heldCount: input.tasks.filter((task) => task.enabled).length - on.length,
    runningCount: input.tasks.filter((task) => task.lastRunStatus === "running").length,
    next,
  };
}

function untilLabel(at: string, nowMs: number): string {
  const minutes = Math.ceil((Date.parse(at) - nowMs) / 60_000);
  if (minutes <= 0) return "due now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

/** "3 automations on · 1 paused · 1 running · next: Review in 6m", or null when none is switched on. */
export function formatAutomationsSummary(
  summary: AutomationsSummary,
  nowMs: number,
): string | null {
  if (summary.onCount + summary.heldCount === 0) return null;
  return [
    `${summary.onCount} ${summary.onCount === 1 ? "automation" : "automations"} on`,
    ...(summary.heldCount > 0 ? [`${summary.heldCount} paused`] : []),
    ...(summary.runningCount > 0 ? [`${summary.runningCount} running`] : []),
    ...(summary.next?.nextRunAt == null
      ? []
      : [`next: ${summary.next.title} ${untilLabel(summary.next.nextRunAt, nowMs)}`]),
  ].join(" · ");
}
