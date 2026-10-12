import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  parseStandingOverrides,
  scopeCovers,
  standingOverrideFromApplied,
  standingSelectionFor,
  userChoseOtherModel,
  withScopedOverride,
} from "./StandingModelOverride.ts";
import { threadScopeOf } from "./OpenThreadModelOverride.ts";

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

describe("standingOverrideFromApplied", () => {
  const sol = (effort: string) => ({
    instanceId: "codex",
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: effort }],
  });
  const read = (applied: ReadonlyArray<unknown>) =>
    standingOverrideFromApplied(applied as Parameters<typeof standingOverrideFromApplied>[0]);

  it("takes the model and the level all threads were set to", () => {
    expect(read([sol("high"), sol("high")])).toEqual({
      model: { instanceId: "codex", model: "gpt-6.1-sol" },
      effort: "high",
    });
  });

  it("keeps only what the threads share", () => {
    expect(read([sol("high"), sol("low")])).toEqual({
      model: { instanceId: "codex", model: "gpt-6.1-sol" },
    });
    expect(read([sol("high"), { instanceId: "grok", model: "grok-4.7" }])).toBeNull();
    expect(read([])).toBeNull();
  });
});

describe("userChoseOtherModel", () => {
  const sol = { instanceId: "codex", model: "gpt-6.1-sol" } as Parameters<
    typeof userChoseOtherModel
  >[1];
  const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as typeof sol;

  it("sees a pick made after the override set its model", () => {
    expect(userChoseOtherModel(sol, opus)).toBe(true);
  });

  it("sees none while the thread still has what the override set, or was never covered", () => {
    expect(userChoseOtherModel(sol, sol)).toBe(false);
    expect(userChoseOtherModel(undefined, opus)).toBe(false);
  });
});

describe("standing overrides per part", () => {
  type Override = Parameters<typeof withScopedOverride>[2];
  const opus = { model: { instanceId: "claudeAgent", model: "claude-opus-5-5" } } as Override;
  const sonnet = { model: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } } as Override;

  it("reads a file from before the split as standing for both parts", () => {
    expect(parseStandingOverrides(JSON.stringify(opus))).toEqual({ tasks: opus, adhoc: opus });
  });

  it("reads each part on its own", () => {
    expect(parseStandingOverrides(JSON.stringify({ tasks: sonnet }))).toEqual({
      tasks: sonnet,
      adhoc: null,
    });
    expect(parseStandingOverrides("not json")).toBeNull();
  });

  it("sets tasks and ad-hoc threads apart, and all of them together", () => {
    const both = withScopedOverride({ tasks: null, adhoc: null }, "all", opus);
    expect(both).toEqual({ tasks: opus, adhoc: opus });
    const split = withScopedOverride(both, "tasks", sonnet);
    expect(split).toEqual({ tasks: sonnet, adhoc: opus });
    expect(withScopedOverride(split, "adhoc", null)).toEqual({ tasks: sonnet, adhoc: null });
  });

  it("counts a thread a task posts to as a task thread", () => {
    const tasks = new Set(["thread-a"]);
    expect(threadScopeOf("thread-a", tasks)).toBe("tasks");
    expect(threadScopeOf("thread-b", tasks)).toBe("adhoc");
    expect(scopeCovers("all", "tasks")).toBe(true);
    expect(scopeCovers("tasks", "adhoc")).toBe(false);
  });
});
