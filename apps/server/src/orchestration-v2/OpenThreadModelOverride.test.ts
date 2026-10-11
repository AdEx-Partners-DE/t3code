import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isOpenThread } from "./OpenThreadModelOverride.ts";

type Thread = Parameters<typeof isOpenThread>[0];
const settledAt = DateTime.makeUnsafe("2026-10-11T08:00:00.000Z");

const thread = (overrides: Partial<Thread> = {}): Thread =>
  ({
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    ...overrides,
  }) as Thread;

describe("isOpenThread", () => {
  it("takes a thread the user still has on the list", () => {
    expect(isOpenThread(thread())).toBe(true);
    // Settled by age, then pulled back by the user.
    expect(isOpenThread(thread({ settledAt, settledOverride: "active" }))).toBe(true);
  });

  it("leaves settled, archived and subagent threads alone", () => {
    expect(isOpenThread(thread({ settledAt }))).toBe(false);
    expect(isOpenThread(thread({ settledOverride: "settled" }))).toBe(false);
    expect(isOpenThread(thread({ archivedAt: settledAt }))).toBe(false);
    expect(
      isOpenThread(thread({ lineage: { relationshipToParent: "subagent" } as Thread["lineage"] })),
    ).toBe(false);
  });
});
