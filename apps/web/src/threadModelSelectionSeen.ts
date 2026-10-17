/**
 * Remembers, per thread, the model selection the server last reported to this
 * browser tab, so the composer can tell when the thread was moved to another
 * model from outside: by the override for all open threads, by another client,
 * or by the server itself.
 *
 * The composer otherwise keeps its own saved pick for a thread, and that pick
 * would hide the change.
 *
 * Each tab holds its composer drafts in memory, so each tab compares against
 * what it saw itself. Storage only seeds a tab when it starts: reading it later
 * would let another tab's sighting of a change hide that change from this tab,
 * whose stale pick then goes out with the next message.
 *
 * @module threadModelSelectionSeen
 */
import type { ModelSelection } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

const STORAGE_KEY = "t3code:thread-model-selection-seen";
/** Oldest entries go first; a thread that drops out is simply seen afresh. */
const MAX_ENTRIES = 400;

type Seen = Record<string, ModelSelection>;

function readStorage(): Seen {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed !== null && typeof parsed === "object" ? (parsed as Seen) : {};
  } catch {
    return {};
  }
}

let seenInTab: Seen | null = null;

export type ThreadModelSelectionSighting = "first" | "changed" | "same";

/**
 * Records `current` as seen for the thread and says how it compares with what
 * this tab saw before.
 */
export function sightThreadModelSelection(
  threadKey: string,
  current: ModelSelection,
): ThreadModelSelectionSighting {
  seenInTab ??= readStorage();
  const previous = seenInTab[threadKey];
  if (previous !== undefined && isSameSelection(previous, current)) return "same";
  seenInTab[threadKey] = current;
  const stored = readStorage();
  // Re-insert so the entry counts as the newest.
  delete stored[threadKey];
  stored[threadKey] = current;
  const keys = Object.keys(stored);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete stored[key];
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // A full or blocked storage only means the next tab starts without it.
  }
  return previous === undefined ? "first" : "changed";
}

export function isSameSelection(left: ModelSelection, right: ModelSelection): boolean {
  try {
    return modelSelectionsEqual(left, right);
  } catch {
    return false;
  }
}

/** Test hook: forget what this tab has seen, as a fresh tab would. */
export function resetThreadModelSelectionSeenForTest(): void {
  seenInTab = null;
}
