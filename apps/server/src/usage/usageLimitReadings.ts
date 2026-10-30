/**
 * Turns successive usage-limit reads into a history: one point whenever a window's
 * reading changes, one reset whenever it starts over. Providers only report the present.
 */
import type { ServerProvider, UsageLimitHistoryPoint, UsageLimitReset } from "@t3tools/contracts";

import { isClaudeModelScopedWindowId } from "../provider/claudeUsageLimits.ts";

/**
 * Only account-wide allowances are kept. A model's own weekly window (Claude's
 * Fable bucket) sits on top of the account's and says nothing about what the
 * subscription left unused.
 */
export function isRecordedUsageWindow(window: { readonly id: string }): boolean {
  return !isClaudeModelScopedWindowId(window.id);
}

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

/**
 * How long a window of each kind runs, so a new reset time tells when the
 * window began. Monthly windows follow the calendar and have no fixed length.
 */
const WINDOW_PERIOD_MS: Partial<Record<UsageLimitHistoryPoint["kind"], number>> = {
  session: 5 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

/**
 * Two probes of one account can disagree by a point or two (the usage API and
 * a turn's rate-limit header round differently), so a small drop on its own
 * says nothing. A window that empties while its reset time stays put was
 * reset early without a new schedule.
 */
const EMPTIED_PERCENT = 2;
const EMPTIED_MIN_DROP_PERCENT = 3;
/** Without reset times to compare, only a drop this large is a reset. */
const UNTIMED_RESET_DROP_PERCENT = 10;

/**
 * Some providers derive the reset time from the moment of the probe, so it
 * wanders by seconds while nothing changed. A real new window moves it by hours.
 */
function sameResetTime(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return Math.abs(Date.parse(left) - Date.parse(right)) < SCHEDULED_RESET_TOLERANCE_MS;
}

/**
 * One series per subscription and window. An instance that switches accounts
 * keeps one series per account, so the switch is not mistaken for a reset.
 */
function usageLimitWindowKey(point: {
  readonly instanceId: string;
  readonly driver?: string | undefined;
  readonly account?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly windowId: string;
}): string {
  return point.account === undefined
    ? `${point.instanceId}\u0000${point.windowId}`
    : [point.driver ?? "", point.account, point.workspaceId ?? "", point.windowId].join("\u0000");
}

/** Whether `point` belongs to a window that began after `previous` was read. */
function startedOver(previous: UsageLimitHistoryPoint, point: UsageLimitHistoryPoint): boolean {
  const drop = previous.usedPercent - point.usedPercent;
  if (!(drop > 0)) return false;
  if (previous.resetsAt === undefined || point.resetsAt === undefined) {
    return drop >= UNTIMED_RESET_DROP_PERCENT;
  }
  const period = WINDOW_PERIOD_MS[point.kind];
  const nextResetMs = Date.parse(point.resetsAt);
  if (period !== undefined) {
    const startMs = nextResetMs - period;
    if (
      startMs >= Date.parse(previous.at) - SCHEDULED_RESET_TOLERANCE_MS &&
      startMs <= Date.parse(point.at) + SCHEDULED_RESET_TOLERANCE_MS
    ) {
      return true;
    }
  } else if (nextResetMs - Date.parse(previous.resetsAt) >= SCHEDULED_RESET_TOLERANCE_MS) {
    return true;
  }
  // A reset time that moved without matching a new window is another account's.
  return (
    sameResetTime(previous.resetsAt, point.resetsAt) &&
    point.usedPercent <= EMPTIED_PERCENT &&
    drop >= EMPTIED_MIN_DROP_PERCENT
  );
}

/**
 * Adds one reading to `state` when it changes the window's series, and
 * returns the reset it reveals. Used for live readings and to rebuild the
 * resets from recorded points, so a corrected rule also corrects the past.
 */
function observeUsageLimitPoint(
  state: Map<string, UsageLimitHistoryPoint>,
  point: UsageLimitHistoryPoint,
): { readonly recorded: boolean; readonly reset?: UsageLimitReset } {
  // A reading of a window that had already ended is a stale cache.
  if (
    point.resetsAt !== undefined &&
    Date.parse(point.resetsAt) < Date.parse(point.at) - SCHEDULED_RESET_TOLERANCE_MS
  ) {
    return { recorded: false };
  }
  const key = usageLimitWindowKey(point);
  const previous = state.get(key);
  if (previous && Date.parse(point.at) <= Date.parse(previous.at)) return { recorded: false };
  if (
    previous &&
    previous.usedPercent === point.usedPercent &&
    sameResetTime(previous.resetsAt, point.resetsAt)
  ) {
    return { recorded: false };
  }
  state.set(key, point);
  if (!previous || !startedOver(previous, point)) return { recorded: true };
  const expectedAtMs = previous.resetsAt === undefined ? Number.NaN : Date.parse(previous.resetsAt);
  return {
    recorded: true,
    reset: {
      at: point.at,
      instanceId: point.instanceId,
      ...(point.driver === undefined ? {} : { driver: point.driver }),
      ...(point.account === undefined ? {} : { account: point.account }),
      ...(point.workspaceId === undefined ? {} : { workspaceId: point.workspaceId }),
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
    },
  };
}

/**
 * The subscription an instance reads for now: its signed-in email, compared
 * the way the pooled limits views compare it, or its credential without one.
 */
function subscriptionOf(
  provider: Partial<Pick<ServerProvider, "auth">> & Pick<ServerProvider, "usageLimits">,
): { readonly account?: string; readonly workspaceId?: string } {
  const account =
    provider.auth?.email?.trim().toLowerCase() || provider.usageLimits?.credentialFingerprint;
  if (account === undefined) return {};
  const workspaceId = provider.auth?.workspaceId;
  return workspaceId === undefined ? { account } : { account, workspaceId };
}

/**
 * A read that could not tell its workspace joins the only workspace recorded
 * for its email, as the pooled limits views do, so one failed lookup does not
 * split a subscription's series.
 */
function withKnownWorkspace(
  state: UsageLimitReadingState,
  driver: string | undefined,
  subscription: { readonly account?: string; readonly workspaceId?: string },
): { readonly account?: string; readonly workspaceId?: string } {
  if (subscription.account === undefined || subscription.workspaceId !== undefined) {
    return subscription;
  }
  const known = new Set<string>();
  for (const point of state.values()) {
    if (point.driver === driver && point.account === subscription.account && point.workspaceId) {
      known.add(point.workspaceId);
    }
  }
  const [only] = known;
  return known.size === 1 && only !== undefined
    ? { account: subscription.account, workspaceId: only }
    : subscription;
}

/**
 * Compares the providers' current readings with the last recorded ones.
 * Unavailable or failed probes record nothing, so a gap stays a gap instead of
 * looking like an allowance that came back.
 */
export function recordUsageLimitReadings(
  state: UsageLimitReadingState,
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "usageLimits"> &
      Partial<Pick<ServerProvider, "driver" | "auth">>
  >,
): UsageLimitReadingDelta {
  const next = new Map(state);
  const points: UsageLimitHistoryPoint[] = [];
  const resets: UsageLimitReset[] = [];
  for (const provider of providers) {
    const usage = provider.usageLimits;
    if (!usage || usage.unavailable) continue;
    const subscription = withKnownWorkspace(next, provider.driver, subscriptionOf(provider));
    for (const window of usage.windows) {
      if (!isRecordedUsageWindow(window)) continue;
      const point: UsageLimitHistoryPoint = {
        at: usage.checkedAt,
        instanceId: provider.instanceId,
        ...(provider.driver === undefined ? {} : { driver: provider.driver }),
        ...subscription,
        windowId: window.id,
        kind: window.kind,
        label: window.label,
        usedPercent: window.usedPercent,
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      };
      const observed = observeUsageLimitPoint(next, point);
      if (!observed.recorded) continue;
      points.push(point);
      if (observed.reset) resets.push(observed.reset);
    }
  }
  return { points, resets, state: next };
}

/** The resets recorded points reveal, oldest first, and the state they leave. */
export function replayUsageLimitPoints(points: ReadonlyArray<UsageLimitHistoryPoint>): {
  readonly resets: ReadonlyArray<UsageLimitReset>;
  readonly state: UsageLimitReadingState;
} {
  const state = new Map<string, UsageLimitHistoryPoint>();
  const resets: UsageLimitReset[] = [];
  for (const point of points) {
    const observed = observeUsageLimitPoint(state, point);
    if (observed.reset) resets.push(observed.reset);
  }
  return { resets, state };
}
