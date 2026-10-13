/**
 * Turns the recorded usage-limit readings into a rate: how much of the weekly
 * allowance all accounts together used in each of the last hours.
 *
 * @module usageBurn
 */
import type { UsageLimitHistoryPoint } from "@t3tools/contracts";

import { subscriptionId, usageRises } from "./usageSeries";

const HOUR_MS = 60 * 60_000;

export interface UsageBurn {
  /** Percentage points used per hour, oldest hour first; the last entry is the running hour. */
  readonly perHour: ReadonlyArray<number>;
  /** Percentage points used in the last 60 minutes. */
  readonly lastHour: number;
  /** The busiest hour in the period, for scaling a chart. */
  readonly peak: number;
}

/**
 * A window's use (see `usageRises`) counts in the hour of the reading that
 * showed it. A reset counts as nothing. Weekly windows are used where an
 * account reports one, because a session window refills several times a day
 * and would count the same work again; accounts without one fall back to all
 * their windows.
 */
export function buildUsageBurn(input: {
  readonly points: ReadonlyArray<UsageLimitHistoryPoint>;
  readonly nowMs: number;
  readonly hours: number;
}): UsageBurn {
  const perHour = Array.from({ length: input.hours }, () => 0);
  let lastHour = 0;
  const startMs = input.nowMs - input.hours * HOUR_MS;
  // By subscription, so two instances signed in to one account count its use once.
  const weeklySubscriptions = new Set(
    input.points.filter((point) => point.kind === "weekly").map(subscriptionId),
  );
  const series = new Map<string, UsageLimitHistoryPoint[]>();
  for (const point of input.points) {
    if (weeklySubscriptions.has(subscriptionId(point)) && point.kind !== "weekly") continue;
    const key = `${subscriptionId(point)}:${point.windowId}`;
    const points = series.get(key) ?? [];
    series.set(key, points);
    points.push(point);
  }
  for (const points of series.values()) {
    points.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    for (const { atMs, rise } of usageRises(points)) {
      if (atMs < startMs || atMs > input.nowMs) continue;
      const bucket = Math.min(input.hours - 1, Math.floor((atMs - startMs) / HOUR_MS));
      perHour[bucket] = perHour[bucket]! + rise;
      if (input.nowMs - atMs <= HOUR_MS) lastHour += rise;
    }
  }
  return { perHour, lastHour, peak: Math.max(0, ...perHour) };
}
