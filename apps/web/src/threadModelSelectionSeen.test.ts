import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  resetThreadModelSelectionSeenForTest,
  sightThreadModelSelection,
} from "./threadModelSelectionSeen";

const STORAGE_KEY = "t3code:thread-model-selection-seen";
const before: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-before",
};
const after: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-after",
};

const entries = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => void entries.set(key, value),
};

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: localStorage, configurable: true });
});

afterEach(() => {
  entries.clear();
  resetThreadModelSelectionSeenForTest();
});

describe("sightThreadModelSelection", () => {
  it("tells a first sighting from a change", () => {
    expect(sightThreadModelSelection("thread-a", before)).toBe("first");
    expect(sightThreadModelSelection("thread-a", before)).toBe("same");
    expect(sightThreadModelSelection("thread-a", after)).toBe("changed");
  });

  it("still reports a change another tab already saw", () => {
    sightThreadModelSelection("thread-a", before);
    // Another tab sees the new selection first and writes it to storage.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "thread-a": after }));
    expect(sightThreadModelSelection("thread-a", after)).toBe("changed");
  });

  it("starts a new tab from what the browser saw", () => {
    sightThreadModelSelection("thread-a", before);
    resetThreadModelSelectionSeenForTest();
    expect(sightThreadModelSelection("thread-a", before)).toBe("same");
    expect(sightThreadModelSelection("thread-a", after)).toBe("changed");
  });
});
