const THREAD_NEXT_WAITING_EVENT = "t3:thread-next-waiting";

interface NextWaitingThreadRequest {
  /** Stay where you are without a message when nothing waits. */
  readonly quiet: boolean;
}

/** Asks the sidebar, which owns the thread order, to open the thread that needs the user most. */
export function requestNextWaitingThread(request: NextWaitingThreadRequest = { quiet: false }) {
  window.dispatchEvent(
    new CustomEvent<NextWaitingThreadRequest>(THREAD_NEXT_WAITING_EVENT, { detail: request }),
  );
}

export function subscribeNextWaitingThread(
  listener: (request: NextWaitingThreadRequest) => void,
): () => void {
  const onEvent = (event: Event) =>
    listener((event as CustomEvent<NextWaitingThreadRequest>).detail);
  window.addEventListener(THREAD_NEXT_WAITING_EVENT, onEvent);
  return () => window.removeEventListener(THREAD_NEXT_WAITING_EVENT, onEvent);
}
