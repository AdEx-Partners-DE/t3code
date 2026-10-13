/** Turns a thread must finish after the checklist before it is rewritten on its own. */
export const AUTO_REFRESH_MIN_TURNS = 3;
/** How old a checklist must be before an automatic rewrite replaces it. */
export const AUTO_REFRESH_MIN_AGE_MS = 15 * 60_000;

/**
 * Whether the open checklist panel should rewrite the checklist by itself.
 * It decides only on an answer fetched since the panel opened: a cached
 * answer from before can predate a rewrite this panel already made, and
 * would ask for the same rewrite again.
 */
export function checklistAutoRefreshNeeded(input: {
  readonly turnsBehind: number;
  readonly checklistGeneratedAt: string | null;
  readonly stale: boolean;
  readonly fetchedAt: number;
  readonly openedAt: number;
  readonly now: number;
}): boolean {
  if (input.fetchedAt < input.openedAt) return false;
  if (input.turnsBehind < AUTO_REFRESH_MIN_TURNS) return false;
  if (input.checklistGeneratedAt === null) return true;
  return (
    input.stale && input.now - Date.parse(input.checklistGeneratedAt) >= AUTO_REFRESH_MIN_AGE_MS
  );
}
