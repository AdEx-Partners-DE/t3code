/**
 * Turns successive usage-limit reads into a history: one point whenever a
 * window's reading changes, and one reset whenever a window's usage drops.
 *
 * A provider only reports where an account stands now. Without the earlier
 * readings nobody can say how the allowance burned down, or how much of it was
 * left when the provider reset every account ahead of schedule.
 *
 * @module usageLimitReadings
 */
import type { ServerProvider, UsageLimitHistoryPoint, UsageLimitReset } from "@t3tools/contracts";

/** The last reading kept per account window, so only changes are recorded. */
export type UsageLimitReadingState = ReadonlyMap<string, UsageLimitHistoryPoint>;

export interface UsageLimitReadingDelta {
  readonly points: ReadonlyArray<UsageLimitHistoryPoint>;
  readonly resets: ReadonlyArray<UsageLimitReset>;
  readonly state: UsageLimitReadingState;
}

/**
 * A provider's reset time and our read of it never line up to the second, and
 * a rolling window may report its reset a little late.
 */
const SCHEDULED_RESET_TOLERANCE_MS = 10 * 60_000;

/** Readings jitter by fractions of a percent between probes; that is not a reset. */
const RESET_DROP_PERCENT = 1;

/**
 * Some providers derive the reset time from the moment of the probe, so it
 * wanders by seconds while nothing changed. A real new window moves it by hours.
 */
function sameResetTime(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return Math.abs(Date.parse(left) - Date.parse(right)) < SCHEDULED_RESET_TOLERANCE_MS;
}

export function usageLimitWindowKey(point: {
  readonly instanceId: string;
  readonly windowId: string;
}): string {
  return `${point.instanceId}\u0000${point.windowId}`;
}

/**
 * Compares the providers' current readings with the last recorded ones.
 * Unavailable or failed probes record nothing, so a gap stays a gap instead of
 * looking like an allowance that came back.
 */
export function recordUsageLimitReadings(
  state: UsageLimitReadingState,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "usageLimits">>,
): UsageLimitReadingDelta {
  const next = new Map(state);
  const points: UsageLimitHistoryPoint[] = [];
  const resets: UsageLimitReset[] = [];
  for (const provider of providers) {
    const usage = provider.usageLimits;
    if (!usage || usage.unavailable) continue;
    for (const window of usage.windows) {
      const point: UsageLimitHistoryPoint = {
        at: usage.checkedAt,
        instanceId: provider.instanceId,
        windowId: window.id,
        kind: window.kind,
        label: window.label,
        usedPercent: window.usedPercent,
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      };
      const key = usageLimitWindowKey(point);
      const previous = next.get(key);
      if (previous && Date.parse(point.at) <= Date.parse(previous.at)) continue;
      if (
        previous &&
        previous.usedPercent === point.usedPercent &&
        sameResetTime(previous.resetsAt, point.resetsAt)
      ) {
        continue;
      }
      if (previous && previous.usedPercent - point.usedPercent >= RESET_DROP_PERCENT) {
        const expectedAtMs =
          previous.resetsAt === undefined ? Number.NaN : Date.parse(previous.resetsAt);
        resets.push({
          at: point.at,
          instanceId: point.instanceId,
          windowId: point.windowId,
          kind: point.kind,
          label: point.label,
          usedPercentBefore: previous.usedPercent,
          unusedPercentBefore: Math.max(0, 100 - previous.usedPercent),
          usedPercentAfter: point.usedPercent,
          lastSeenBeforeAt: previous.at,
          ...(previous.resetsAt === undefined ? {} : { expectedAt: previous.resetsAt }),
          // Unknown schedule counts as on schedule: there is nothing to be early against.
          ahead:
            Number.isFinite(expectedAtMs) &&
            Date.parse(point.at) < expectedAtMs - SCHEDULED_RESET_TOLERANCE_MS,
        });
      }
      points.push(point);
      next.set(key, point);
    }
  }
  return { points, resets, state: next };
}
