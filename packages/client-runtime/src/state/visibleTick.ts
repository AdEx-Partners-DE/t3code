// @effect-diagnostics globalTimers:off - A page visibility clock for atoms, outside an Effect runtime.
import { Atom } from "effect/reactivity";

/** The part of a page's `document` the tick watches. */
export type VisibilityPage = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

/**
 * Counts up every `intervalMs` while the page is shown, and right away when a
 * hidden page is shown again. Without a page (mobile) it counts all the time.
 * As a query's refresh trigger it polls only while someone can see the result.
 */
export function makeVisibleTickAtom(intervalMs: number, page: VisibilityPage | null) {
  return Atom.make((get) => {
    let ticks = 0;
    const tick = () => {
      if (page?.visibilityState !== "hidden") get.setSelf(++ticks);
    };
    const timer = setInterval(tick, intervalMs);
    page?.addEventListener("visibilitychange", tick);
    get.addFinalizer(() => {
      clearInterval(timer);
      page?.removeEventListener("visibilitychange", tick);
    });
    return ticks;
  }).pipe(Atom.withLabel("visible-tick"));
}
