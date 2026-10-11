/**
 * Remembers, per thread, the model selection the server last reported to this
 * browser, so the composer can tell when the thread was moved to another model
 * from outside: by the override for all open threads, by another client, or by
 * the server itself.
 *
 * The composer otherwise keeps its own saved pick for a thread, and that pick
 * would hide the change.
 *
 * @module threadModelSelectionSeen
 */
import type { ModelSelection } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

const STORAGE_KEY = "t3code:thread-model-selection-seen";
/** Oldest entries go first; a thread that drops out is simply seen afresh. */
const MAX_ENTRIES = 400;

type Seen = Record<string, ModelSelection>;

function read(): Seen {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed !== null && typeof parsed === "object" ? (parsed as Seen) : {};
  } catch {
    return {};
  }
}

/**
 * Records `current` as seen for the thread and says whether it differs from
 * what was seen before. The first sighting of a thread is not a change.
 */
export function threadModelSelectionChanged(threadKey: string, current: ModelSelection): boolean {
  const seen = read();
  const previous = seen[threadKey];
  if (previous !== undefined && isSameSelection(previous, current)) return false;
  // Re-insert so the entry counts as the newest.
  delete seen[threadKey];
  seen[threadKey] = current;
  const keys = Object.keys(seen);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete seen[key];
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // A full or blocked storage only means the next change goes unnoticed.
  }
  return previous !== undefined;
}

function isSameSelection(left: ModelSelection, right: ModelSelection): boolean {
  try {
    return modelSelectionsEqual(left, right);
  } catch {
    return false;
  }
}
