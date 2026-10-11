import { ProviderInstanceId, type ModelSelection, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { overriddenModelSelection } from "./modelOverride.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

const model = (slug: string, optionId: string | null, levels: ReadonlyArray<string>) => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities:
    optionId === null
      ? null
      : {
          optionDescriptors: [
            {
              id: optionId,
              label: "Thinking",
              type: "select" as const,
              options: levels.map((level) => ({ id: level, label: level })),
            },
          ],
        },
});

const providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">> = [
  { instanceId: codex, models: [model("gpt-6", "reasoningEffort", ["low", "medium", "high"])] },
  {
    instanceId: claude,
    models: [model("opus", "effort", ["low", "high", "max"]), model("haiku", null, [])],
  },
];

const current: ModelSelection = {
  instanceId: codex,
  model: "gpt-6",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ],
};

describe("overriddenModelSelection", () => {
  it("changes only the thinking level when no model is named", () => {
    expect(overriddenModelSelection({ current, override: { effort: "low" }, providers })).toEqual({
      instanceId: codex,
      model: "gpt-6",
      options: [
        { id: "fastMode", value: true },
        { id: "reasoningEffort", value: "low" },
      ],
    });
  });

  it("moves to the named model with that model's own thinking option", () => {
    expect(
      overriddenModelSelection({
        current,
        override: { model: { instanceId: claude, model: "opus" }, effort: "high" },
        providers,
      }),
    ).toEqual({ instanceId: claude, model: "opus", options: [{ id: "effort", value: "high" }] });
  });

  it("leaves the level alone on a model that does not offer it", () => {
    expect(
      overriddenModelSelection({
        current,
        override: { model: { instanceId: claude, model: "opus" }, effort: "medium" },
        providers,
      }),
    ).toEqual({ instanceId: claude, model: "opus" });
    expect(
      overriddenModelSelection({
        current,
        override: { model: { instanceId: claude, model: "haiku" }, effort: "high" },
        providers,
      }),
    ).toEqual({ instanceId: claude, model: "haiku" });
  });

  it("reports no change when the thread already matches", () => {
    expect(
      overriddenModelSelection({ current, override: { effort: "high" }, providers }),
    ).toBeNull();
    expect(
      overriddenModelSelection({
        current,
        override: { model: { instanceId: codex, model: "gpt-6" } },
        providers,
      }),
    ).toBeNull();
    expect(overriddenModelSelection({ current, override: {}, providers })).toBeNull();
  });
});
