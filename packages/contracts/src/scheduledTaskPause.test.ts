import { describe, expect, it } from "vite-plus/test";

import { isTaskHeldByPause, taskRunsOnItsOwn } from "./scheduledTask.ts";

describe("task pause", () => {
  it("holds every task while the pause is on, except the ones resumed by hand", () => {
    expect(isTaskHeldByPause("a", true, [])).toBe(true);
    expect(isTaskHeldByPause("a", true, ["a"])).toBe(false);
    expect(isTaskHeldByPause("b", true, ["a"])).toBe(true);
    // Without the pause nothing is held, whatever list is left over.
    expect(isTaskHeldByPause("b", false, ["a"])).toBe(false);
  });

  it("shows a task's switch on only when it would really run", () => {
    const on = { id: "a", enabled: true };
    const off = { id: "a", enabled: false };
    expect(taskRunsOnItsOwn(on, false, [])).toBe(true);
    expect(taskRunsOnItsOwn(on, true, [])).toBe(false);
    expect(taskRunsOnItsOwn(on, true, ["a"])).toBe(true);
    expect(taskRunsOnItsOwn(off, true, ["a"])).toBe(false);
  });
});
