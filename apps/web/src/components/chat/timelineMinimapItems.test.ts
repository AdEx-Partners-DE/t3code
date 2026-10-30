import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";
import type { ChatMessage } from "../../types";

function rows(
  entries: ReadonlyArray<readonly ["user" | "assistant", string]>,
): MessagesTimelineRow[] {
  const messages: ChatMessage[] = entries.map(([role, text], index) => ({
    id: MessageId.make(`message-${index}`),
    role,
    text,
    streaming: false,
    runId: null,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
  }));
  return messages.map((message) => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  }));
}

describe("timeline minimap previews", () => {
  it("marks the turn that ended on an error, and only that one", () => {
    const source = rows([
      ["user", "First"],
      ["assistant", "Fine"],
      ["user", "Second"],
      ["user", "Third"],
      ["assistant", "Fine again"],
    ]);
    const failure = {
      kind: "event",
      id: "event-error",
      createdAt: new Date(0).toISOString(),
      projectedItem: { item: { type: "error", status: "failed" } },
    } as unknown as MessagesTimelineRow;
    const withFailure = [...source.slice(0, 3), failure, ...source.slice(3)];
    expect(deriveTimelineMinimapItems(withFailure).map((item) => item.failed)).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe("resolveTimelineMinimapPreview", () => {
  it("previews a thread autolink as prose, not its URL", () => {
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: null,
      failed: false,
      assistantText:
        "Started <t3-thread://v2/env-1/thread-1> and [Fix CI](t3-thread://v2/env-1/t2).",
    });
    expect(preview?.assistantText).toBe("Started a thread and Fix CI.");
  });
});
