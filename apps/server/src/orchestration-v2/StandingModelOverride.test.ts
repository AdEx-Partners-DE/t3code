import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { standingSelectionFor } from "./StandingModelOverride.ts";

type Input = Parameters<typeof standingSelectionFor>[0];
const thread = (overrides: Partial<Input["thread"]> = {}) =>
  ({
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
    ...overrides,
  }) as Input["thread"];

describe("standingSelectionFor", () => {
  it("asks for nothing without a standing override", () => {
    expect(standingSelectionFor({ override: null, thread: thread(), providers: [] })).toBeNull();
  });

  it("leaves a thread alone that is not on the user's list", () => {
    const override = { effort: "low" };
    const settledAt = DateTime.makeUnsafe("2026-10-11T08:00:00.000Z");
    expect(
      standingSelectionFor({ override, thread: thread({ settledAt }), providers: [] }),
    ).toBeNull();
    expect(
      standingSelectionFor({
        override,
        thread: thread({ archivedAt: settledAt }),
        providers: [],
      }),
    ).toBeNull();
  });
});
