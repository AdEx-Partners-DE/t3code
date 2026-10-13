/**
 * How recorded usage-limit readings form series: one per subscription and
 * window, and what each series really used.
 *
 * @module usageSeries
 */
import type { UsageLimitHistoryPoint } from "@t3tools/contracts";

/**
 * One subscription per provider, signed-in account and workspace. Readings
 * recorded before the account was kept stay with their instance.
 */
export function subscriptionId(entry: {
  readonly instanceId: string;
  readonly driver?: string | undefined;
  readonly account?: string | undefined;
  readonly workspaceId?: string | undefined;
}): string {
  return entry.account === undefined
    ? `instance:${entry.instanceId}`
    : `account:${entry.driver ?? ""}:${entry.account}:${entry.workspaceId ?? ""}`;
}

/** Reset times this far apart belong to different windows. */
const NEW_WINDOW_MS = 10 * 60_000;
/** A drop this large starts a new window even when the reset time stays put. */
const NEW_WINDOW_DROP = 10;

/**
 * The use one window's readings show, oldest first in, one entry per reading
 * that went past the highest reading so far. Two probes of one account can
 * round a point apart and alternate (90, 91, 90, 91); measured from the high
 * point that is one point of use, not one per alternation. A new window
 * starts the count over and is not use.
 */
export function usageRises(
  points: ReadonlyArray<UsageLimitHistoryPoint>,
): ReadonlyArray<{ readonly atMs: number; readonly rise: number }> {
  const rises: Array<{ readonly atMs: number; readonly rise: number }> = [];
  let high: UsageLimitHistoryPoint | undefined;
  let previous: UsageLimitHistoryPoint | undefined;
  for (const point of points) {
    // Against the reading before, so a reset time that drifts slowly is not a new window.
    const newWindow =
      previous === undefined ||
      previous.usedPercent - point.usedPercent >= NEW_WINDOW_DROP ||
      (previous.resetsAt !== undefined &&
        point.resetsAt !== undefined &&
        Math.abs(Date.parse(point.resetsAt) - Date.parse(previous.resetsAt)) >= NEW_WINDOW_MS);
    previous = point;
    if (newWindow || high === undefined) {
      high = point;
      continue;
    }
    if (point.usedPercent > high.usedPercent) {
      rises.push({ atMs: Date.parse(point.at), rise: point.usedPercent - high.usedPercent });
      high = point;
    }
  }
  return rises;
}
