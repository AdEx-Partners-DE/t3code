/**
 * Shapes the recorded usage-limit history for the Limits view: one burn-down
 * line per subscription window, and the weekly resets that happened in the
 * period.
 *
 * @module usageLimitTrend
 */
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
  type UsageLimitHistory,
  type UsageLimitHistoryPoint,
  type UsageLimitReset,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";

import { subscriptionId, usageRises } from "./usageSeries";

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
 * One window's use (see `usageRises`), counted on the day of the reading that
 * showed it. `sinceMs` is the start of the first day.
 */
export function usedPerDay(
  points: ReadonlyArray<UsageLimitHistoryPoint>,
  sinceMs: number,
  nowMs: number,
): number[] {
  const days = Math.max(1, Math.ceil((nowMs - sinceMs) / DAY_MS));
  const perDay = Array.from({ length: days }, () => 0);
  for (const { atMs, rise } of usageRises(points)) {
    if (atMs < sinceMs || atMs > nowMs) continue;
    const day = Math.min(days - 1, Math.floor((atMs - sinceMs) / DAY_MS));
    perDay[day] = round(perDay[day]! + rise);
  }
  return perDay;
}

export interface UsageLimitTrendAccount {
  /** The subscription: provider and signed-in account, or the instance for older readings. */
  readonly id: string;
  /** The instance signed in to the subscription now, or else the one that recorded it. */
  readonly instanceId: string;
  readonly name: string;
  readonly lines: ReadonlyArray<UsageLimitTrendLine>;
  /** Weekly windows only, newest first. */
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

type TrendProvider = Pick<ServerProvider, "instanceId" | "driver" | "displayName"> &
  Partial<Pick<ServerProvider, "auth" | "usageLimits">>;

/**
 * Subscriptions with at least one recorded reading, in the order the providers
 * are listed. A subscription is named by provider and email, since one
 * instance can switch accounts and two instances can share one. A
 * subscription no provider signs in to anymore keeps its history, after the
 * known ones; older readings without an account keep their instance's name.
 */
export function buildUsageLimitTrend(input: {
  readonly history: UsageLimitHistory;
  readonly providers: ReadonlyArray<TrendProvider>;
  readonly sinceMs: number;
  readonly nowMs: number;
}): ReadonlyArray<UsageLimitTrendAccount> {
  const bySubscription = new Map<
    string,
    {
      readonly sample: UsageLimitHistoryPoint;
      readonly windows: Map<string, UsageLimitHistoryPoint[]>;
    }
  >();
  // Only the long windows: weekly and monthly allowance is what goes unused
  // or runs out. The five-hour session window refills many times a day and
  // would bury them.
  for (const point of input.history.points) {
    if (point.kind === "session") continue;
    const id = subscriptionId(point);
    const subscription = bySubscription.get(id) ?? { sample: point, windows: new Map() };
    bySubscription.set(id, subscription);
    const points = subscription.windows.get(point.windowId) ?? [];
    subscription.windows.set(point.windowId, points);
    points.push(point);
  }
  // The instance signed in to a subscription now. One that recorded it but has
  // since switched to another account is not it.
  const providerOf = (sample: UsageLimitHistoryPoint): TrendProvider | undefined =>
    sample.account === undefined
      ? input.providers.find((provider) => provider.instanceId === sample.instanceId)
      : input.providers.find(
          (provider) =>
            (sample.driver === undefined || provider.driver === sample.driver) &&
            // As the server names it: the email, or the credential without one.
            (provider.auth?.email?.trim().toLowerCase() ||
              provider.usageLimits?.credentialFingerprint) === sample.account &&
            provider.auth?.workspaceId === sample.workspaceId,
        );
  const emailNames = new Map<string, number>();
  for (const [, { sample }] of bySubscription) {
    if (sample.account === undefined) continue;
    const key = `${sample.driver ?? ""}:${sample.account}`;
    emailNames.set(key, (emailNames.get(key) ?? 0) + 1);
  }
  const nameOf = (sample: UsageLimitHistoryPoint, provider: TrendProvider | undefined) => {
    // A credential fingerprint is not a name; such a subscription goes by its instance.
    if (sample.account?.includes("@")) {
      const driver = (sample.driver ?? provider?.driver) as ProviderDriverKind | undefined;
      const providerName = driver ? (PROVIDER_DISPLAY_NAMES[driver] ?? driver) : undefined;
      const name = providerName ? `${providerName} · ${sample.account}` : sample.account;
      // One email in several workspaces: tell them apart.
      return sample.workspaceId !== undefined &&
        (emailNames.get(`${sample.driver ?? ""}:${sample.account}`) ?? 0) > 1
        ? `${name} (${sample.workspaceId.slice(0, 8)})`
        : name;
    }
    const recorder = input.providers.find((entry) => entry.instanceId === sample.instanceId);
    return recorder ? resolveProviderInstanceDisplayName(recorder) : sample.instanceId;
  };
  const order = (provider: TrendProvider | undefined) =>
    provider === undefined ? Number.MAX_SAFE_INTEGER : input.providers.indexOf(provider);
  return [...bySubscription.entries()]
    .map(([id, subscription]) => ({
      id,
      ...subscription,
      provider: providerOf(subscription.sample),
    }))
    .sort(
      (left, right) =>
        order(left.provider) - order(right.provider) || left.id.localeCompare(right.id),
    )
    .map(({ id, sample, windows, provider }) => {
      const resets = input.history.resets.filter(
        (reset) => subscriptionId(reset) === id && windows.has(reset.windowId),
      );
      return {
        id,
        instanceId: provider?.instanceId ?? sample.instanceId,
        name: nameOf(sample, provider),
        lines: [...windows.entries()].map(([windowId, points]) => {
          const sorted = [...points].sort(
            (left, right) => Date.parse(left.at) - Date.parse(right.at),
          );
          const last = sorted.at(-1)!;
          const forecast = forecastUsageWindow(sorted, input.nowMs);
          const span = Math.max(1, input.nowMs - input.sinceMs);
          const windowResets = resets.filter(
            (reset) => reset.windowId === windowId && Date.parse(reset.at) >= input.sinceMs,
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
        // Weekly only: that is the allowance a reset can throw away.
        resets: resets
          .filter((reset) => reset.kind === "weekly")
          .sort((left, right) => Date.parse(right.at) - Date.parse(left.at)),
      };
    });
}

/**
 * What an account's long window (weekly or monthly, not the session window)
 * had left at a moment in the past, in words: "Weekly 32% left". Readings are
 * recorded only where they change, so the last one before the moment holds.
 * Null without a reading, or when that window had reset before the moment and
 * no reading followed.
 */
export function limitLeftAt(
  points: UsageLimitHistory["points"],
  instanceId: string,
  atMs: number,
): string | null {
  let latest: UsageLimitHistory["points"][number] | null = null;
  for (const point of points) {
    if (point.instanceId !== instanceId || point.kind === "session") continue;
    const pointMs = Date.parse(point.at);
    if (pointMs > atMs) continue;
    if (latest === null || pointMs >= Date.parse(latest.at)) latest = point;
  }
  if (latest === null) return null;
  if (latest.resetsAt !== undefined && Date.parse(latest.resetsAt) <= atMs) return null;
  return `${latest.label} ${Math.max(0, Math.round(100 - latest.usedPercent))}% left`;
}
