import { describe, expect, it } from "vite-plus/test";

import {
  canMergeQueuedMessages,
  mergeQueuedMessageTexts,
  removeMergedQueuedRuns,
} from "./queuedMessageMerge";

const message = (text: string, attachments: ReadonlyArray<unknown> = []) => ({ text, attachments });

describe("canMergeQueuedMessages", () => {
  it("needs two or more messages", () => {
    expect(canMergeQueuedMessages([])).toBe(false);
    expect(canMergeQueuedMessages([message("a")])).toBe(false);
    expect(canMergeQueuedMessages([message("a"), message("b")])).toBe(true);
  });

  it("allows attachments only on the first message", () => {
    expect(canMergeQueuedMessages([message("a", ["image"]), message("b")])).toBe(true);
    expect(canMergeQueuedMessages([message("a"), message("b", ["image"])])).toBe(false);
  });
});

describe("mergeQueuedMessageTexts", () => {
  it("keeps queue order and separates the messages by a blank line", () => {
    expect(
      mergeQueuedMessageTexts([message("First."), message("  Second.\n"), message("Third.")]),
    ).toBe("First.\n\nSecond.\n\nThird.");
  });

  it("skips messages without text", () => {
    expect(mergeQueuedMessageTexts([message("First."), message("   "), message("Third.")])).toBe(
      "First.\n\nThird.",
    );
  });
});

describe("removeMergedQueuedRuns", () => {
  it("returns the messages that stayed in the queue, in order", async () => {
    const tried: string[] = [];
    const kept = await removeMergedQueuedRuns(["b", "c", "d"], async (runId) => {
      tried.push(runId);
      if (runId === "c") return { _tag: "Failure" };
      if (runId === "d") throw new Error("connection lost");
      return { _tag: "Success" };
    });
    expect(tried).toEqual(["b", "c", "d"]);
    expect(kept).toEqual(["c", "d"]);
  });

  it("returns nothing when every removal succeeds", async () => {
    expect(await removeMergedQueuedRuns(["b", "c"], async () => ({ _tag: "Success" }))).toEqual([]);
  });
});
