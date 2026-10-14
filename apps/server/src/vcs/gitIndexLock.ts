/**
 * A Git command holds the index lock for seconds. A lock that has not changed
 * for this long outlived the command that took it (a crash, a killed process,
 * a restart) and will not go away on its own.
 */
export const ABANDONED_INDEX_LOCK_MS = 10 * 60_000;

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.floor(hours / 24)} days`;
}

/**
 * What status says about a locked index: wait for a fresh lock, and name the
 * file to delete for one that looks abandoned. `modifiedAtMs` is undefined
 * when the lock's time could not be read.
 */
export function indexLockDetail(input: {
  readonly lockPath: string;
  readonly modifiedAtMs: number | undefined;
  readonly nowMs: number;
}): string {
  const age = input.modifiedAtMs === undefined ? 0 : input.nowMs - input.modifiedAtMs;
  if (age < ABANDONED_INDEX_LOCK_MS) {
    return "Git index is locked. Status will resume when the index lock is removed.";
  }
  return `Git index is locked and the lock has not changed for ${formatAge(age)}. If no Git command is running in this checkout, delete ${input.lockPath}.`;
}
