import { ProviderDriverKind, ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { modelPickOptions } from "./useComposerSelection.logic";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const oneNeutrino = ProviderInstanceId.make("codex");
const stark = ProviderInstanceId.make("codex_stark_cli");
const threadOptions = [
  { id: "reasoningEffort", value: "max" },
  { id: "serviceTier", value: "fast" },
];
const remembered = [{ id: "reasoningEffort", value: "low" }];
const thread: ModelSelection = {
  instanceId: oneNeutrino,
  model: "gpt-6.2-sol",
  options: threadOptions,
};

it.each([
  [
    "the same model on another account keeps the thread's options",
    stark,
    codex,
    true,
    remembered,
    threadOptions,
  ],
  [
    "another model on another account takes what was last used there",
    stark,
    codex,
    false,
    remembered,
    remembered,
  ],
  [
    "another model with nothing remembered starts from defaults",
    stark,
    codex,
    false,
    undefined,
    undefined,
  ],
  [
    "another provider never takes the thread's options",
    ProviderInstanceId.make("claudeAgent"),
    claude,
    true,
    undefined,
    undefined,
  ],
  [
    "the same model on the same account keeps remembered options first",
    oneNeutrino,
    codex,
    true,
    remembered,
    remembered,
  ],
  [
    "the same model on the same account falls back to the thread's options",
    oneNeutrino,
    codex,
    true,
    undefined,
    threadOptions,
  ],
] as const)("%s", (_name, instanceId, driver, sameModel, rememberedOptions, expected) => {
  expect(
    modelPickOptions({
      pick: { instanceId, driver },
      thread,
      threadDriver: codex,
      sameModel,
      remembered: rememberedOptions,
    }),
  ).toEqual(expected);
});
