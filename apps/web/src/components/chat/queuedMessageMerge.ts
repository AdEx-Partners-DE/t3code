/**
 * Merging the messages waiting in one thread's queue into one, so they run as
 * a single turn instead of one turn each.
 */
export interface MergeableQueuedMessage {
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}

/**
 * Whether the queue can be merged: two or more messages, and only the first
 * carries attachments. A text edit keeps the first message's attachments;
 * moving another message's files onto it would mean uploading them again.
 */
export function canMergeQueuedMessages(queued: ReadonlyArray<MergeableQueuedMessage>): boolean {
  return queued.length >= 2 && queued.slice(1).every((message) => message.attachments.length === 0);
}

/** The merged text: each message in queue order, separated by a blank line. */
export function mergeQueuedMessageTexts(queued: ReadonlyArray<MergeableQueuedMessage>): string {
  return queued
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}
