import { describe, expect, it } from "@effect/vitest";

import { waitingQueuesOf } from "./QueueOverview.ts";

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
