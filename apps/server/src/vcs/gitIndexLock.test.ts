import { describe, expect, it } from "@effect/vitest";

import { ABANDONED_INDEX_LOCK_MS, indexLockDetail } from "./gitIndexLock.ts";

const lockPath = "/repo/.git/index.lock";
const nowMs = Date.parse("2026-10-14T09:00:00Z");

describe("indexLockDetail", () => {
  it("asks to wait while a Git command may still hold the lock", () => {
    expect(
      indexLockDetail({ lockPath, modifiedAtMs: nowMs - ABANDONED_INDEX_LOCK_MS + 1, nowMs }),
    ).toBe("Git index is locked. Status will resume when the index lock is removed.");
    expect(indexLockDetail({ lockPath, modifiedAtMs: undefined, nowMs })).toContain(
      "Status will resume",
    );
  });

  it("names the file to delete once the lock looks abandoned", () => {
    expect(indexLockDetail({ lockPath, modifiedAtMs: nowMs - 25 * 60_000, nowMs })).toBe(
      "Git index is locked and the lock has not changed for 25 minutes. If no Git command is running in this checkout, delete /repo/.git/index.lock.",
    );
    expect(indexLockDetail({ lockPath, modifiedAtMs: nowMs - 24 * 3_600_000, nowMs })).toContain(
      "for 24 hours",
    );
    expect(indexLockDetail({ lockPath, modifiedAtMs: nowMs - 3 * 86_400_000, nowMs })).toContain(
      "for 3 days",
    );
  });
});
