/**
 * Statuses the user sets on checklist items by hand, and how they survive a
 * model rewrite. A rewrite works from the transcript; without this, an item
 * the user closed comes back open whenever the model reads it that way.
 *
 * @module checklistUserStatus
 */
import type { ThreadChecklistItem } from "@t3tools/contracts";

const sameText = (left: string, right: string) =>
  left.replace(/\s+/g, " ").trim().toLowerCase() ===
  right.replace(/\s+/g, " ").trim().toLowerCase();

/** Sets the status of the item with this text; null when the list has none. */
export function setChecklistItemStatus(
  items: ReadonlyArray<ThreadChecklistItem>,
  text: string,
  status: ThreadChecklistItem["status"],
): ReadonlyArray<ThreadChecklistItem> | null {
  if (!items.some((item) => sameText(item.text, text))) return null;
  return items.map((item) =>
    sameText(item.text, text) ? { ...item, status, setByUser: true as const } : item,
  );
}

/** Drops the hand mark of the item with this text; null when the list has none. */
export function releaseChecklistItem(
  items: ReadonlyArray<ThreadChecklistItem>,
  text: string,
): ReadonlyArray<ThreadChecklistItem> | null {
  if (!items.some((item) => sameText(item.text, text))) return null;
  return items.map((item) => {
    if (!sameText(item.text, text)) return item;
    const { setByUser: _setByUser, ...released } = item;
    return released;
  });
}

/** The previous list as the model reads it, with the statuses the user set marked. */
export function checklistForPrompt(items: ReadonlyArray<ThreadChecklistItem>) {
  return items.map((item) => ({
    text: item.text,
    status: item.status,
    ...(item.setByUser === true ? { setByUser: true } : {}),
  }));
}

/**
 * Keeps what the user decided across a rewrite. A rewritten item with the
 * same text takes the user's status. An item the user parked, kept open or
 * flagged comes back if the model dropped it; one the user marked done may
 * go, as finished items do.
 */
export function keepUserStatuses(
  previous: ReadonlyArray<ThreadChecklistItem>,
  generated: ReadonlyArray<ThreadChecklistItem>,
): ReadonlyArray<ThreadChecklistItem> {
  const decided = previous.filter((item) => item.setByUser === true);
  if (decided.length === 0) return generated;
  const kept = generated.map((item) => {
    const user = decided.find((candidate) => sameText(candidate.text, item.text));
    return user === undefined ? item : { ...item, status: user.status, setByUser: true as const };
  });
  const dropped = decided.filter(
    (item) =>
      item.status !== "done" && !generated.some((candidate) => sameText(candidate.text, item.text)),
  );
  return [...kept, ...dropped];
}
