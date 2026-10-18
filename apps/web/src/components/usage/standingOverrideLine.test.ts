import { describe, expect, it } from "vite-plus/test";

import { standingOverrideLine, threadsOffModelRule } from "./standingOverrideLine";

const nameOf = (instanceId: string) =>
  instanceId === "claude_oneneutrino" ? "Claude One Neutrino" : instanceId;
const rule = { model: { instanceId: "claude_oneneutrino", model: "claude-opus-5-5" } };

describe("standingOverrideLine", () => {
  it("says nothing while no override is in force", () => {
    expect(standingOverrideLine({ tasks: null, adhoc: null }, nameOf)).toBeNull();
  });

  it("names one rule once when both parts follow it", () => {
    expect(standingOverrideLine({ tasks: rule, adhoc: rule }, nameOf)).toBe(
      "Model rule for all open threads: Claude One Neutrino · claude-opus-5-5",
    );
  });

  it("names each part when only one part or two different rules are in force", () => {
    expect(standingOverrideLine({ tasks: rule, adhoc: null }, nameOf)).toBe(
      "Model rule for task threads: Claude One Neutrino · claude-opus-5-5",
    );
    expect(
      standingOverrideLine(
        { tasks: rule, adhoc: { effort: "high", keepOwnAccount: true } },
        nameOf,
      ),
    ).toBe(
      "Model rule for task threads: Claude One Neutrino · claude-opus-5-5; other threads: thinking high, each on its own account",
    );
  });
});

describe("threadsOffModelRule", () => {
  const providers = [
    {
      instanceId: "claude_oneneutrino",
      driver: "claudeAgent",
      models: [{ slug: "claude-opus-5-5" }],
    },
  ] as unknown as Parameters<typeof threadsOffModelRule>[2];
  const on = { modelSelection: { instanceId: "claude_oneneutrino", model: "claude-opus-5-5" } };
  const off = { modelSelection: { instanceId: "codex", model: "gpt-6-astra" } };
  const threads = [on, off, off] as unknown as Parameters<typeof threadsOffModelRule>[1];

  it("counts the open threads one rule for both parts would still move", () => {
    expect(threadsOffModelRule({ tasks: rule, adhoc: rule }, threads, providers)).toBe(2);
  });

  it("gives no count when the parts differ or only one is in force", () => {
    expect(threadsOffModelRule({ tasks: rule, adhoc: null }, threads, providers)).toBeNull();
    expect(
      threadsOffModelRule({ tasks: rule, adhoc: { effort: "high" } }, threads, providers),
    ).toBeNull();
  });
});
