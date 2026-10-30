/**
 * Which other accounts of the same provider can take over a thread that hit a
 * usage limit. Shared by web and mobile so both offer the same targets.
 *
 * @module limitSwitchTargets
 */
import type { ModelSelection, ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

import { exhaustedUsageWindow, rankLimitSwitchCandidates } from "@t3tools/shared/usageLimitSwitch";

import { resolveProviderInstanceDisplayName } from "./providerInstanceDisplay.ts";

export interface LimitSwitchTarget {
  readonly selection: ModelSelection;
  readonly label: string;
  /** Headroom of the tightest known window, or null when the account reports none. */
  readonly remainingPercent: number | null;
}

/** Below this much left, the five-hour session window is worth showing instead of the weekly one. */
const SESSION_WINDOW_SHOWN_BELOW_PERCENT = 15;

/**
 * The window for a compact readout: the weekly or monthly window closest to running out.
 * The five-hour session window refills often, so it shows only when nearly empty.
 * Null when the account reports no windows, so the caller shows nothing.
 */
export function tightestUsageWindow(
  provider: Pick<ServerProvider, "usageLimits">,
): { readonly label: string; readonly remainingPercent: number } | null {
  const usage = provider.usageLimits;
  if (!usage || usage.unavailable) return null;
  // Judged at the read itself, so rendering stays pure; the next probe replaces it.
  const readAtMs = Date.parse(usage.checkedAt);
  const tightestOf = (windows: ReadonlyArray<ServerProviderUsageWindow>) =>
    windows.reduce<ServerProviderUsageWindow | undefined>(
      (current, window) =>
        current === undefined || window.usedPercent > current.usedPercent ? window : current,
      undefined,
    );
  const current = usage.windows
    // A window whose reset has passed describes the previous period.
    .filter((window) => window.resetsAt === undefined || Date.parse(window.resetsAt) > readAtMs);
  const long = tightestOf(current.filter((window) => window.kind !== "session"));
  const session = tightestOf(current.filter((window) => window.kind === "session"));
  const sessionNearlyEmpty =
    session !== undefined &&
    100 - session.usedPercent < SESSION_WINDOW_SHOWN_BELOW_PERCENT &&
    (long === undefined || session.usedPercent > long.usedPercent);
  const shown = sessionNearlyEmpty ? session : (long ?? session);
  return shown
    ? { label: shown.label, remainingPercent: Math.max(0, 100 - shown.usedPercent) }
    : null;
}

/**
 * Other ready, signed-in instances of the current instance's driver that offer
 * the thread's model and are not known to be out of quota, best first. See
 * `rankLimitSwitchCandidates` for the order.
 */
export function listLimitSwitchTargets(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly nowMs: number;
}): ReadonlyArray<LimitSwitchTarget> {
  return rankLimitSwitchCandidates(input).map((candidate) => ({
    selection: candidate.selection,
    label: resolveProviderInstanceDisplayName(candidate.provider),
    remainingPercent: candidate.remainingPercent,
  }));
}

/** At or below this headroom the selected account is worth a heads-up. */
const LOW_REMAINING_PERCENT = 10;

export interface LimitSwitchSuggestion {
  readonly sourceLabel: string;
  readonly window: ServerProviderUsageWindow;
  /** Headroom left in `window`; 0 once it is used up. */
  readonly remainingPercent: number;
  /**
   * Set when the window is used up and the account has credits, so turns keep
   * running and draw them down. The balance is the provider's own unit.
   */
  readonly spendingCredits: { readonly balance: string | null } | null;
  readonly targets: ReadonlyArray<LimitSwitchTarget>;
}

/**
 * Set once the selected account is low on, or out of, a window and another
 * account can take over, or once it is out and running on credits. A provider
 * that keeps running past its allowance, as Codex does on credits, never fails
 * the turn, so the window is the only signal.
 */
export function suggestLimitSwitch(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly nowMs: number;
}): LimitSwitchSuggestion | null {
  const source = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  if (!source) return null;
  const window =
    exhaustedUsageWindow(source, input.nowMs) ??
    source.usageLimits?.windows
      .filter(
        (candidate) =>
          100 - candidate.usedPercent <= LOW_REMAINING_PERCENT &&
          (candidate.resetsAt === undefined || Date.parse(candidate.resetsAt) > input.nowMs),
      )
      .reduce<ServerProviderUsageWindow | undefined>(
        (tightest, candidate) =>
          tightest === undefined || candidate.usedPercent > tightest.usedPercent
            ? candidate
            : tightest,
        undefined,
      );
  if (!window) return null;
  const targets = listLimitSwitchTargets(input);
  const credits = source.usageLimits?.credits;
  const spendingCredits =
    window.usedPercent >= 100 && credits && (credits.hasCredits || credits.unlimited)
      ? { balance: credits.unlimited ? null : (credits.balance ?? null) }
      : null;
  // Without another account there is nothing to offer, but silently spending
  // credits is still worth saying.
  return targets.length === 0 && spendingCredits === null
    ? null
    : {
        sourceLabel: resolveProviderInstanceDisplayName(source),
        window,
        remainingPercent: Math.max(0, 100 - window.usedPercent),
        spendingCredits,
        targets,
      };
}
