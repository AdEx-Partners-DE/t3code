import { describe, expect, it } from "@effect/vitest";

import { REPLY_PREVIEW_LENGTH, replyPreview, waitingQueuesOf } from "./QueueOverview.ts";

describe("waitingQueuesOf", () => {
  it("keeps open threads only and puts the longest wait first", () => {
    const rows = [
      { thread_id: "thread:new", waiting: 1, held: 0, oldest: "2026-10-11T16:00:00.000Z" },
      { thread_id: "thread:settled", waiting: 4, held: 4, oldest: "2026-10-10T08:00:00.000Z" },
      { thread_id: "thread:old", waiting: 37, held: 37, oldest: "2026-10-11T05:40:00.000Z" },
    ];
    expect(waitingQueuesOf(rows, new Set(["thread:new", "thread:old"]))).toEqual([
      {
        threadId: "thread:old",
        waiting: 37,
        held: 37,
        oldestQueuedAt: "2026-10-11T05:40:00.000Z",
      },
      { threadId: "thread:new", waiting: 1, held: 0, oldestQueuedAt: "2026-10-11T16:00:00.000Z" },
    ]);
  });
});

describe("replyPreview", () => {
  it("folds a reply into one line", () => {
    expect(replyPreview("Done.\n\n- fixed the test\n- pushed")).toBe(
      "Done. - fixed the test - pushed",
    );
  });

  it("cuts a long reply at a word and marks the cut", () => {
    const preview = replyPreview("word ".repeat(100));
    expect(preview.length).toBeLessThanOrEqual(REPLY_PREVIEW_LENGTH + 1);
    expect(preview.endsWith("word…")).toBe(true);
  });
});
