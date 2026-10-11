/**
 * Lets a panel next to the conversation scroll it to one message.
 *
 * Only one conversation timeline is on screen at a time, so it registers
 * itself here and callers need no reference to it.
 */
type Reveal = (messageId: string) => boolean;

let current: Reveal | null = null;

/** The timeline registers how it scrolls to a message; returns the undo. */
export function registerTimelineReveal(reveal: Reveal): () => void {
  current = reveal;
  return () => {
    if (current === reveal) current = null;
  };
}

/** False when the message is not among the loaded part of the thread. */
export function revealInTimeline(messageId: string): boolean {
  return current?.(messageId) ?? false;
}
