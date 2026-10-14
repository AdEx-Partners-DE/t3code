import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { AtomRegistry } from "effect/reactivity";

import { makeVisibleTickAtom, type VisibilityPage } from "./visibleTick.ts";

function fakePage(visibilityState: DocumentVisibilityState) {
  const target = new EventTarget();
  const page = {
    visibilityState,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  return {
    page: page as unknown as VisibilityPage,
    show: (state: DocumentVisibilityState) => {
      page.visibilityState = state;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

describe("makeVisibleTickAtom", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks on its interval only while the page is shown, and once on showing it again", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { page, show } = fakePage("visible");
    const atom = makeVisibleTickAtom(1_000, page);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);

    vi.advanceTimersByTime(2_000);
    expect(registry.get(atom)).toBe(2);

    show("hidden");
    vi.advanceTimersByTime(5_000);
    expect(registry.get(atom)).toBe(2);

    show("visible");
    expect(registry.get(atom)).toBe(3);
    unmount();
  });

  it("ticks all the time without a page", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const atom = makeVisibleTickAtom(1_000, null);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);

    vi.advanceTimersByTime(3_000);
    expect(registry.get(atom)).toBe(3);
    unmount();
  });
});
