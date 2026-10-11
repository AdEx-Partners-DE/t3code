/**
 * Lets a panel next to the conversation scroll it to one message.
 *
 * Only one conversation timeline is on screen at a time, so it registers
 * itself here and callers need no reference to it.
 */
type Reveal = (messageId: string) => boolean;

let current: Reveal | null = null;

// A reveal asked for before its thread was on screen. It is tried again each
// time the timeline registers, which it does whenever its rows change.
let pending: { readonly messageId: string; readonly untilMs: number } | null = null;
const PENDING_REVEAL_MS = 10_000;

/** The timeline registers how it scrolls to a message; returns the undo. */
export function registerTimelineReveal(reveal: Reveal): () => void {
  current = reveal;
  if (pending !== null) {
    if (Date.now() > pending.untilMs || reveal(pending.messageId)) pending = null;
  }
  return () => {
    if (current === reveal) current = null;
  };
}

/** For a thread that is being opened: reveals the message once its part of the thread has loaded. */
export function revealInTimelineWhenLoaded(messageId: string): void {
  if (current?.(messageId)) return;
  pending = { messageId, untilMs: Date.now() + PENDING_REVEAL_MS };
}

/** False when the message is not among the loaded part of the thread. */
export function revealInTimeline(messageId: string): boolean {
  return current?.(messageId) ?? false;
}
