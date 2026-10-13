import { describe, expect, it } from "vite-plus/test";

import {
  AUTO_REFRESH_MIN_AGE_MS,
  AUTO_REFRESH_MIN_TURNS,
  checklistAutoRefreshNeeded,
} from "./ThreadChecklistPanel.logic";

const OPENED = Date.parse("2026-10-13T18:27:00.000Z");
const base = {
  turnsBehind: AUTO_REFRESH_MIN_TURNS,
  checklistGeneratedAt: new Date(OPENED - AUTO_REFRESH_MIN_AGE_MS - 60_000).toISOString(),
  stale: true,
  fetchedAt: OPENED + 500,
  openedAt: OPENED,
  now: OPENED + 1_000,
};

describe("checklistAutoRefreshNeeded", () => {
  it("rewrites an old checklist once the thread is enough turns ahead", () => {
    expect(checklistAutoRefreshNeeded(base)).toBe(true);
  });

  it("waits for an answer fetched since the panel opened", () => {
    // The cached answer predates a rewrite the panel made a minute ago.
    expect(checklistAutoRefreshNeeded({ ...base, fetchedAt: OPENED - 60_000 })).toBe(false);
  });

  it("leaves a recent checklist alone although turns have passed", () => {
    const recent = new Date(OPENED - 60_000).toISOString();
    expect(checklistAutoRefreshNeeded({ ...base, checklistGeneratedAt: recent })).toBe(false);
  });

  it("waits for enough turns, and writes a first checklist once they are there", () => {
    expect(checklistAutoRefreshNeeded({ ...base, turnsBehind: AUTO_REFRESH_MIN_TURNS - 1 })).toBe(
      false,
    );
    expect(checklistAutoRefreshNeeded({ ...base, checklistGeneratedAt: null })).toBe(true);
  });
});
