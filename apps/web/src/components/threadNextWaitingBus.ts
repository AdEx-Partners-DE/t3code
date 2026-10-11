const THREAD_NEXT_WAITING_EVENT = "t3:thread-next-waiting";

/** Asks the sidebar, which owns the thread order, to open the thread that needs the user most. */
export function requestNextWaitingThread(): void {
  window.dispatchEvent(new Event(THREAD_NEXT_WAITING_EVENT));
}

export function subscribeNextWaitingThread(listener: () => void): () => void {
  window.addEventListener(THREAD_NEXT_WAITING_EVENT, listener);
  return () => window.removeEventListener(THREAD_NEXT_WAITING_EVENT, listener);
}
