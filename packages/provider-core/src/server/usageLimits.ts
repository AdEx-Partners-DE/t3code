import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

/**
 * Fold a sparse runtime update into the limits a provider currently
 * publishes. Windows upsert by `id`; a window the update omits keeps its
 * previous values, and a window that arrives without `resetsAt` or
 * `windowDurationMins` keeps whatever the last probe resolved for it.
 * Credit-only updates can change the balance without changing any window.
 *
 * An `unsupported` snapshot stays unsupported: an account that cannot have
 * subscription windows will not start reporting them mid-turn.
 *
 * An update never completes a read. Merged onto a failed probe, or onto no
 * probe at all, it keeps the windows it names but leaves the snapshot
 * `probeFailed`. Otherwise one streamed window would read as the account's
 * full list, and the next failed probe would keep it as the last good one.
 */
export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (
    (update.windows.length === 0 && update.credits === undefined) ||
    previous?.unavailable?.reason === "unsupported"
  ) {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
  const credits = update.credits === undefined ? previous?.credits : update.credits;
  let changed =
    (update.credits === null && previous?.credits !== null) ||
    credits?.balance !== previous?.credits?.balance ||
    credits?.hasCredits !== previous?.credits?.hasCredits ||
    credits?.unlimited !== previous?.credits?.unlimited;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined) {
    return previous;
  }
  const unavailable =
    previous === undefined ? { reason: "probeFailed" as const } : previous.unavailable;
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(previous?.credentialFingerprint !== undefined
      ? { credentialFingerprint: previous.credentialFingerprint }
      : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

/**
 * Choose what to publish after a status probe finishes. A probe that failed
 * this time must not wipe bars a previous probe or a turn already
 * established, so the last good snapshot stays; `unsupported` is
 * authoritative and replaces them.
 *
 * A successful probe replaces the published windows only when its read is
 * at least as recent. Finishing a probe does not make its usage read newer;
 * an older probe still contributes its metadata.
 */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    // Credits stream beside the windows, so the newer read owns both.
    return {
      ...probed,
      checkedAt: published.checkedAt,
      windows: published.windows,
      ...(published.credits !== undefined ? { credits: published.credits } : {}),
    };
  }
  return probed;
}
