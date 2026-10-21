import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  alignsBeforeMessage,
  parseStandingOverrides,
  scopeCovers,
  describeSelection,
  standingAlignmentStep,
  standingOverrideFromApplied,
  standingSelectionFor,
  switchWaitsForRun,
  userChoseOtherModel,
  userWroteSinceOverride,
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

describe("userWroteSinceOverride", () => {
  const setAt = Date.parse("2026-10-12T17:18:00Z");
  const typed = (at: string, scheduledTaskId?: string) =>
    ({
      createdBy: "user",
      createdAt: DateTime.makeUnsafe(at),
      ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
    }) as Parameters<typeof userWroteSinceOverride>[0]["messages"][number];
  const sol = { instanceId: "codex", model: "gpt-6.1-sol" } as Parameters<
    typeof userChoseOtherModel
  >[1];

  it("keeps a thread the user started on their own model after the rule was set", () => {
    expect(
      userWroteSinceOverride({
        applied: undefined,
        messages: [typed("2026-10-16T13:54:36Z")],
        overrideSetAtMs: setAt,
      }),
    ).toBe(true);
  });

  it("aligns a thread the user last wrote in before the rule, or only a task wrote in since", () => {
    expect(
      userWroteSinceOverride({
        applied: undefined,
        messages: [typed("2026-10-11T09:00:00Z")],
        overrideSetAtMs: setAt,
      }),
    ).toBe(false);
    // A task the user created posts as "user" too; it is not the user's pick.
    expect(
      userWroteSinceOverride({
        applied: undefined,
        messages: [
          typed("2026-10-11T09:00:00Z"),
          typed("2026-10-16T17:18:07Z", "scheduled-task:mine"),
        ],
        overrideSetAtMs: setAt,
      }),
    ).toBe(false);
    expect(
      userWroteSinceOverride({ applied: undefined, messages: [], overrideSetAtMs: setAt }),
    ).toBe(false);
    expect(
      userWroteSinceOverride({
        applied: undefined,
        messages: [typed("2026-10-16T13:54:36Z")],
        overrideSetAtMs: null,
      }),
    ).toBe(false);
  });

  it("leaves a thread the rule already moved to userChoseOtherModel", () => {
    expect(
      userWroteSinceOverride({
        applied: sol,
        messages: [typed("2026-10-16T13:54:36Z")],
        overrideSetAtMs: setAt,
      }),
    ).toBe(false);
  });
});

describe("describeSelection", () => {
  it("names the thinking level, which can differ from the rule on the same model", () => {
    type Selection = Parameters<typeof describeSelection>[0];
    expect(
      describeSelection({
        instanceId: "codex_stark_cli",
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "max" }],
      } as unknown as Selection),
    ).toBe("codex_stark_cli/gpt-6-astra (max)");
    expect(
      describeSelection({ instanceId: "codex", model: "gpt-6-astra" } as unknown as Selection),
    ).toBe("codex/gpt-6-astra");
  });
});

describe("switchWaitsForRun", () => {
  type Selection = Parameters<typeof switchWaitsForRun>[0]["current"];
  const claude = { instanceId: "claude_oneneutrino", model: "claude-opus-5-5" } as Selection;
  const codex = { instanceId: "codex", model: "gpt-6-astra" } as Selection;
  const codexHigh = {
    ...codex,
    options: [{ id: "reasoningEffort", value: "high" }],
  } as Selection;

  it("holds a switch to another instance while a run is under way", () => {
    expect(switchWaitsForRun({ activeRunId: "run:1", current: claude, next: codex })).toBe(true);
  });

  it("moves an idle thread, and a running one within its instance", () => {
    expect(switchWaitsForRun({ activeRunId: null, current: claude, next: codex })).toBe(false);
    expect(switchWaitsForRun({ activeRunId: "run:1", current: codex, next: codexHigh })).toBe(
      false,
    );
  });
});

describe("standingAlignmentStep", () => {
  type Selection = Parameters<typeof standingAlignmentStep>[0]["current"];
  const astra = { instanceId: "codex_stark_cli", model: "gpt-6-astra" } as Selection;
  const sol = { instanceId: "codex_stark_cli", model: "gpt-6.1-sol" } as Selection;

  it("needs nothing for a thread already on the rule's model, chosen or not", () => {
    expect(standingAlignmentStep({ next: astra, current: astra, keepsOwnChoice: true })).toBe(
      "none",
    );
    expect(standingAlignmentStep({ next: astra, current: astra, keepsOwnChoice: false })).toBe(
      "none",
    );
  });

  it("keeps a differing choice of the user and aligns any other thread", () => {
    expect(standingAlignmentStep({ next: astra, current: sol, keepsOwnChoice: true })).toBe(
      "kept-own-choice",
    );
    expect(standingAlignmentStep({ next: astra, current: sol, keepsOwnChoice: false })).toBe(
      "align",
    );
    expect(standingAlignmentStep({ next: null, current: sol, keepsOwnChoice: false })).toBe("none");
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

  it("leaves a provider's own wake on the session that holds its work", () => {
    // 15.10.: aligning such a wake moved a thread to the other Claude account,
    // which closed the session and killed the subagent the wake reported on.
    expect(alignsBeforeMessage({ creationSource: "provider" })).toBe(false);
    expect(alignsBeforeMessage({ creationSource: "server" })).toBe(true);
    expect(alignsBeforeMessage({ creationSource: "mcp" })).toBe(true);
    expect(
      alignsBeforeMessage({
        creationSource: "server",
        modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      }),
    ).toBe(false);
  });

  it("counts a thread a task posts to as a task thread", () => {
    const tasks = new Set(["thread-a"]);
    expect(threadScopeOf("thread-a", tasks)).toBe("tasks");
    expect(threadScopeOf("thread-b", tasks)).toBe("adhoc");
    expect(scopeCovers("all", "tasks")).toBe(true);
    expect(scopeCovers("tasks", "adhoc")).toBe(false);
  });
});
