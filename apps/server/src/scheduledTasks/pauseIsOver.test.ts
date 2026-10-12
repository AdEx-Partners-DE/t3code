import { describe, expect, it } from "@effect/vitest";

import { pauseIsOver } from "./ScheduledTaskService.ts";

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
