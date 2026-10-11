/**
 * Cuts a thread down to the text a checklist is written from.
 *
 * A checklist has to see the whole thread, because the points that matter most
 * are the ones buried many turns back. So nothing is dropped by age alone:
 * what the user wrote stays, each turn keeps the agent's closing reply, and a
 * prompt an automation repeats is written out once.
 *
 * @module threadChecklistTranscript
 */
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type TranscriptMessage = Pick<
  OrchestrationV2ConversationMessage,
  "id" | "role" | "text" | "runId" | "createdAt" | "scheduledTaskId" | "notification"
>;

const USER_LIMIT = 1_500;
const REPLY_LIMIT = 2_400;
/** Replies in the older part of an over-long thread are cut to this. */
const OLD_REPLY_LIMIT = 500;

const clip = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)} […]`;
};

/**
 * `messages` in thread order. `budget` is the most characters the transcript
 * may take; an over-long thread first shortens the agent's older replies and
 * then drops the oldest of them, never the user's own words.
 */
export function buildChecklistTranscript(
  messages: ReadonlyArray<TranscriptMessage>,
  budget: number,
): string {
  return buildChecklistTranscriptWithSources(messages, budget).transcript;
}

/**
 * The transcript plus, per entry number in it, the message it came from, so a
 * checklist item that names an entry can lead back to its place in the thread.
 */
export function buildChecklistTranscriptWithSources(
  messages: ReadonlyArray<TranscriptMessage>,
  budget: number,
): {
  readonly transcript: string;
  readonly messageIdOfEntry: ReadonlyMap<number, TranscriptMessage["id"]>;
} {
  // The closing reply of a turn is the one that says what was done.
  const lastReplyOfRun = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.runId !== null && message.text.trim() !== "") {
      lastReplyOfRun.set(message.runId, message.id);
    }
  }
  interface Entry {
    readonly messageId: TranscriptMessage["id"];
    readonly who: "USER" | "AUTOMATION" | "AGENT";
    readonly at: string;
    text: string;
    dropped: boolean;
  }
  const entries: Entry[] = [];
  const automationPrompts = new Map<string, number>();
  // Queued messages are stored when they are sent, not when their turn runs.
  const inOrder = messages.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
  );
  for (const message of inOrder) {
    if (message.role === "system" || message.text.trim() === "") continue;
    // Server notices (a restart, a retry) are not part of the work.
    if (message.role === "user" && message.notification !== undefined) continue;
    const at = DateTime.formatIso(message.createdAt).slice(0, 16).replace("T", " ");
    if (message.role === "assistant") {
      if (message.runId !== null && lastReplyOfRun.get(message.runId) !== message.id) continue;
      entries.push({
        messageId: message.id,
        who: "AGENT",
        at,
        text: clip(message.text, REPLY_LIMIT),
        dropped: false,
      });
      continue;
    }
    if (message.scheduledTaskId !== undefined) {
      const first = automationPrompts.get(message.text);
      if (first !== undefined) {
        entries.push({
          messageId: message.id,
          who: "AUTOMATION",
          at,
          text: `(same prompt as entry ${first})`,
          dropped: false,
        });
        continue;
      }
      automationPrompts.set(message.text, entries.length + 1);
      entries.push({
        messageId: message.id,
        who: "AUTOMATION",
        at,
        text: clip(message.text, USER_LIMIT),
        dropped: false,
      });
      continue;
    }
    entries.push({
      messageId: message.id,
      who: "USER",
      at,
      text: clip(message.text, USER_LIMIT),
      dropped: false,
    });
  }
  const size = () =>
    entries.reduce((total, entry) => total + (entry.dropped ? 0 : entry.text.length + 40), 0);
  if (size() > budget) {
    const olderHalf = Math.floor(entries.length / 2);
    for (let index = 0; index < olderHalf; index += 1) {
      const entry = entries[index]!;
      if (entry.who === "AGENT") entry.text = clip(entry.text, OLD_REPLY_LIMIT);
    }
  }
  for (let index = 0; index < entries.length && size() > budget; index += 1) {
    if (entries[index]!.who !== "USER") entries[index]!.dropped = true;
  }
  return {
    transcript: entries
      .map((entry, index) =>
        entry.dropped ? null : `[${index + 1}] ${entry.who} ${entry.at}: ${entry.text}`,
      )
      .filter((line) => line !== null)
      .join("\n"),
    messageIdOfEntry: new Map(
      entries.flatMap((entry, index) =>
        entry.dropped ? [] : [[index + 1, entry.messageId] as const],
      ),
    ),
  };
}
