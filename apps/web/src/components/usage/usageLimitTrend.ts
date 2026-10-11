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

export interface UsageLimitTrendLine {
  readonly windowId: string;
  readonly label: string;
  /** Remaining allowance now, by the last recorded reading. */
  readonly remainingPercent: number;
  /**
   * SVG polyline points in a 0..100 by 0..100 box: x is time across the
   * period, y is 0 at a full allowance and 100 at an empty one. Stepped,
   * because a reading holds until the next one.
   */
  readonly path: string;
}

export interface UsageLimitTrendAccount {
  readonly instanceId: string;
  readonly name: string;
  readonly lines: ReadonlyArray<UsageLimitTrendLine>;
  /** Newest first. */
  readonly resets: ReadonlyArray<UsageLimitReset>;
}

const round = (value: number) => Math.round(value * 100) / 100;

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
  for (const point of input.history.points) {
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
          return {
            windowId,
            label: last.label,
            remainingPercent: Math.max(0, 100 - last.usedPercent),
            path: steppedPath(sorted, input.sinceMs, input.nowMs),
          };
        }),
        resets: input.history.resets
          .filter((reset) => reset.instanceId === instanceId)
          .sort((left, right) => Date.parse(right.at) - Date.parse(left.at)),
      };
    });
}
