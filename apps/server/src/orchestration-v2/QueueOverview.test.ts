import { describe, expect, it } from "@effect/vitest";

import type { ThreadId } from "@t3tools/contracts";

import {
  newestContextLoad,
  pendingQuestionsOf,
  REPLY_PREVIEW_LENGTH,
  replyPreview,
  waitingQueuesOf,
} from "./QueueOverview.ts";

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

describe("pendingQuestionsOf", () => {
  it("keeps open threads only and puts the longest wait first", () => {
    const rows = [
      { thread_id: "thread:new", since: "2026-10-12T11:40:00.000Z" },
      { thread_id: "thread:settled", since: "2026-10-12T08:00:00.000Z" },
      { thread_id: "thread:old", since: "2026-10-12T10:31:29.838Z" },
    ];
    expect(pendingQuestionsOf(rows, new Set(["thread:new", "thread:old"]))).toEqual([
      { threadId: "thread:old", since: "2026-10-12T10:31:29.838Z" },
      { threadId: "thread:new", since: "2026-10-12T11:40:00.000Z" },
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

describe("newestContextLoad", () => {
  const threadId = "thread-1" as ThreadId;

  it("takes the newest report by its time, not by turn order", () => {
    expect(
      newestContextLoad(threadId, [
        // A subagent's turn started later but reported earlier.
        { used_tokens: 40_000, max_tokens: 200_000, updated_at: "2026-10-14T09:00:00.000Z" },
        { used_tokens: 412_000, max_tokens: 1_000_000, updated_at: "2026-10-14T09:05:00.000Z" },
        { used_tokens: null, max_tokens: null, updated_at: null },
      ]),
    ).toEqual({ threadId, usedTokens: 412_000, maxTokens: 1_000_000 });
  });

  it("knows nothing for a thread whose turns never reported", () => {
    expect(
      newestContextLoad(threadId, [{ used_tokens: null, max_tokens: null, updated_at: null }]),
    ).toBeNull();
  });

  it("leaves the limit out when the provider did not say it", () => {
    expect(
      newestContextLoad(threadId, [
        { used_tokens: 90_000, max_tokens: null, updated_at: "2026-10-14T09:00:00.000Z" },
      ]),
    ).toEqual({ threadId, usedTokens: 90_000 });
  });
});
