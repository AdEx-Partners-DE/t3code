import { describe, expect, it } from "vite-plus/test";

import { standingOverrideLine } from "./standingOverrideLine";

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
