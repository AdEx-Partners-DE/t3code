import { describe, expect, it } from "@effect/vitest";

import { dueTasksToStartNow, pauseIsOver, TASK_START_GAP_MS } from "./ScheduledTaskService.ts";

describe("pauseIsOver", () => {
  it("lasts while one enabled task is still held", () => {
    expect(pauseIsOver(["a", "b"], ["a"])).toBe(false);
  });

  it("ends when every enabled task has been switched on again", () => {
    expect(pauseIsOver(["a", "b"], ["b", "a"])).toBe(true);
    // Tasks that are off do not keep a pause alive.
    expect(pauseIsOver([], [])).toBe(true);
  });
});

describe("dueTasksToStartNow", () => {
  it("starts one or two due tasks as before", () => {
    expect(dueTasksToStartNow(["a", "b"], 1_000, 1_001)).toEqual(["a", "b"]);
    expect(dueTasksToStartNow([], null, 1_000)).toEqual([]);
  });

  it("starts a pile one task at a time, the longest due first", () => {
    expect(dueTasksToStartNow(["a", "b", "c"], null, 1_000)).toEqual(["a"]);
  });

  it("keeps the gap inside a pile and goes on once it has passed", () => {
    const pile = ["b", "c", "d"];
    expect(dueTasksToStartNow(pile, 1_000, 1_000 + TASK_START_GAP_MS - 1)).toEqual([]);
    expect(dueTasksToStartNow(pile, 1_000, 1_000 + TASK_START_GAP_MS)).toEqual(["b"]);
  });
});
