/**
 * Shapes the recorded usage-limit history for the Limits view: one burn-down
 * line per account window, and the resets that happened in the period.
 *
 * @module usageLimitTrend
 */
import type {
  ServerProvider,
  UsageLimitHistory,
  UsageLimitHistoryPoint,
  UsageLimitReset,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";

/**
 * Where a window ends up if the account keeps its pace since the last reset:
 * empty before the reset, or at the reset with allowance to spare.
 */
export type UsageLimitForecast =
  | { readonly type: "runs-out"; readonly at: string; readonly resetsAt: string }
  | { readonly type: "lasts"; readonly unusedPercent: number; readonly resetsAt: string };

/** A pace measured over less than this says nothing yet. */
const FORECAST_MIN_ELAPSED_MS = 60 * 60_000;

/**
 * `points` are one window's readings, oldest first. The pace is taken from the
 * readings since the last drop, which is the current cycle. No forecast
 * without an announced reset still ahead, or before an hour of the cycle has
 * been recorded.
 */
export function forecastUsageWindow(
  points: ReadonlyArray<UsageLimitHistoryPoint>,
  nowMs: number,
): UsageLimitForecast | null {
  const last = points.at(-1);
  if (last === undefined || last.resetsAt === undefined) return null;
  const resetsAtMs = Date.parse(last.resetsAt);
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= nowMs) return null;
  let start = last;
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const point = points[index]!;
    if (point.usedPercent > start.usedPercent) break;
    start = point;
  }
  const elapsedMs = nowMs - Date.parse(start.at);
  if (!(elapsedMs >= FORECAST_MIN_ELAPSED_MS)) return null;
  const pacePerMs = (last.usedPercent - start.usedPercent) / elapsedMs;
  const usedAtReset = last.usedPercent + pacePerMs * (resetsAtMs - nowMs);
  if (usedAtReset < 100) {
    return {
      type: "lasts",
      unusedPercent: Math.round(100 - usedAtReset),
      resetsAt: last.resetsAt,
    };
  }
  const emptyAtMs = pacePerMs <= 0 ? nowMs : nowMs + (100 - last.usedPercent) / pacePerMs;
  return {
    type: "runs-out",
    at: new Date(Math.min(emptyAtMs, resetsAtMs)).toISOString(),
    resetsAt: last.resetsAt,
  };
}

export interface UsageLimitTrendLine {
  readonly windowId: string;
  readonly label: string;
  /** A session window refills several times a day; what it leaves unused is not lost the way a week's is. */
  readonly kind: UsageLimitHistoryPoint["kind"];
  /** Absent when there is not enough to go on. */
  readonly forecast?: UsageLimitForecast;
  /** Where this window reset in the period, as x positions 0..100. */
  readonly resetMarks: ReadonlyArray<number>;
  /** Percentage points of allowance that were still there at the resets in the period. */
  readonly unusedAtResets: number;
  /** Percentage points used on each day of the period, oldest first. */
  readonly usedPerDay: ReadonlyArray<number>;
  /** Remaining allowance now, by the last recorded reading. */
  readonly remainingPercent: number;
  /**
   * SVG polyline points in a 0..100 by 0..100 box: x is time across the
   * period, y is 0 at a full allowance and 100 at an empty one. Stepped,
   * because a reading holds until the next one.
   */
  readonly path: string;
}

const round = (value: number) => Math.round(value * 100) / 100;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Rises between consecutive readings, counted on the day of the later
 * reading. A drop is a reset and counts as nothing. `sinceMs` is the start of
 * the first day.
 */
export function usedPerDay(
  points: ReadonlyArray<UsageLimitHistoryPoint>,
  sinceMs: number,
  nowMs: number,
): number[] {
  const days = Math.max(1, Math.ceil((nowMs - sinceMs) / DAY_MS));
  const perDay = Array.from({ length: days }, () => 0);
  for (let index = 1; index < points.length; index += 1) {
    const rise = points[index]!.usedPercent - points[index - 1]!.usedPercent;
    const atMs = Date.parse(points[index]!.at);
    if (!(rise > 0) || atMs < sinceMs || atMs > nowMs) continue;
    const day = Math.min(days - 1, Math.floor((atMs - sinceMs) / DAY_MS));
    perDay[day] = round(perDay[day]! + rise);
  }
  return perDay;
}

export interface UsageLimitTrendAccount {
  readonly instanceId: string;
  readonly name: string;
  readonly lines: ReadonlyArray<UsageLimitTrendLine>;
  /** Newest first. */
  readonly resets: ReadonlyArray<UsageLimitReset>;
}

function steppedPath(
  points: ReadonlyArray<UsageLimitHistoryPoint>,
  sinceMs: number,
  nowMs: number,
): string {
  const span = Math.max(1, nowMs - sinceMs);
  const x = (atMs: number) =>
    round(((Math.min(Math.max(atMs, sinceMs), nowMs) - sinceMs) / span) * 100);
  const coordinates: string[] = [];
  let previousY: number | null = null;
  for (const point of points) {
    const px = x(Date.parse(point.at));
    const py = round(point.usedPercent);
    // Hold the previous reading up to this moment, then step to the new one.
    if (previousY !== null) coordinates.push(`${px},${previousY}`);
    coordinates.push(`${px},${py}`);
    previousY = py;
  }
  if (previousY !== null) coordinates.push(`100,${previousY}`);
  return coordinates.join(" ");
}

/**
 * Accounts with at least one recorded reading, in the order the providers are
 * listed. An account the server no longer knows keeps its instance id as name,
 * so its history does not vanish with the account.
 */
export function buildUsageLimitTrend(input: {
  readonly history: UsageLimitHistory;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "displayName">>;
  readonly sinceMs: number;
  readonly nowMs: number;
}): ReadonlyArray<UsageLimitTrendAccount> {
  const byInstance = new Map<string, Map<string, UsageLimitHistoryPoint[]>>();
  // Only the long windows: weekly and monthly allowance is what goes unused
  // or runs out. The five-hour session window refills many times a day and
  // would bury them.
  for (const point of input.history.points) {
    if (point.kind === "session") continue;
    const windows = byInstance.get(point.instanceId) ?? new Map<string, UsageLimitHistoryPoint[]>();
    byInstance.set(point.instanceId, windows);
    const points = windows.get(point.windowId) ?? [];
    windows.set(point.windowId, points);
    points.push(point);
  }
  const order = new Map(
    input.providers.map((provider, index) => [provider.instanceId as string, index]),
  );
  return [...byInstance.entries()]
    .sort(
      ([left], [right]) =>
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right),
    )
    .map(([instanceId, windows]) => {
      const provider = input.providers.find((entry) => entry.instanceId === instanceId);
      return {
        instanceId,
        name: provider ? resolveProviderInstanceDisplayName(provider) : instanceId,
        lines: [...windows.entries()].map(([windowId, points]) => {
          const sorted = [...points].sort(
            (left, right) => Date.parse(left.at) - Date.parse(right.at),
          );
          const last = sorted.at(-1)!;
          const forecast = forecastUsageWindow(sorted, input.nowMs);
          const span = Math.max(1, input.nowMs - input.sinceMs);
          const windowResets = input.history.resets.filter(
            (reset) =>
              reset.instanceId === instanceId &&
              reset.windowId === windowId &&
              Date.parse(reset.at) >= input.sinceMs,
          );
          return {
            resetMarks: windowResets.map((reset) =>
              round(((Date.parse(reset.at) - input.sinceMs) / span) * 100),
            ),
            unusedAtResets: round(
              windowResets.reduce((total, reset) => total + reset.unusedPercentBefore, 0),
            ),
            usedPerDay: usedPerDay(sorted, input.sinceMs, input.nowMs),
            ...(forecast === null ? {} : { forecast }),
            windowId,
            label: last.label,
            kind: last.kind,
            remainingPercent: Math.max(0, 100 - last.usedPercent),
            path: steppedPath(sorted, input.sinceMs, input.nowMs),
          };
        }),
        resets: input.history.resets
          .filter((reset) => reset.instanceId === instanceId && windows.has(reset.windowId))
          .sort((left, right) => Date.parse(right.at) - Date.parse(left.at)),
      };
    });
}
