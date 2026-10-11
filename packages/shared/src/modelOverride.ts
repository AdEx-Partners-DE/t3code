/**
 * Works out what a thread's model selection becomes under an override that
 * names a model, a thinking level, or both.
 *
 * @module modelOverride
 */
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

import { modelSelectionsEqual } from "./model.ts";

export interface ModelOverride {
  /** The model every thread moves to. Absent keeps each thread's own model. */
  readonly model?: Pick<ModelSelection, "instanceId" | "model"> | undefined;
  /** A thinking level such as "low", "medium" or "high". Absent keeps the level. */
  readonly effort?: string | undefined;
}

type OverrideProvider = Pick<ServerProvider, "instanceId" | "models">;

/**
 * Providers name their thinking option differently ("effort",
 * "reasoningEffort"), so it is found by name and by offering the wanted level.
 * A model that does not offer the level keeps what it has.
 */
function effortOptionId(
  providers: ReadonlyArray<OverrideProvider>,
  target: Pick<ModelSelection, "instanceId" | "model">,
  effort: string,
): string | null {
  const model = providers
    .find((provider) => provider.instanceId === target.instanceId)
    ?.models.find((candidate) => candidate.slug === target.model);
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (candidate) =>
      candidate.type === "select" &&
      /effort/i.test(candidate.id) &&
      candidate.options.some((option) => option.id === effort),
  );
  return descriptor?.id ?? null;
}

/**
 * The selection `current` becomes under `override`, or null when nothing
 * changes. Moving to another model drops the old model's options, since they
 * belong to that model; staying on the model keeps them.
 */
export function overriddenModelSelection(input: {
  readonly current: ModelSelection;
  readonly override: ModelOverride;
  readonly providers: ReadonlyArray<OverrideProvider>;
}): ModelSelection | null {
  const { current, override } = input;
  const target = override.model ?? current;
  const sameModel = target.instanceId === current.instanceId && target.model === current.model;
  let options = sameModel ? [...(current.options ?? [])] : [];
  if (override.effort !== undefined) {
    const optionId = effortOptionId(input.providers, target, override.effort);
    if (optionId !== null) {
      options = [
        ...options.filter((option) => option.id !== optionId),
        { id: optionId, value: override.effort },
      ];
    }
  }
  const next: ModelSelection = {
    instanceId: target.instanceId,
    model: target.model,
    ...(options.length === 0 ? {} : { options }),
  };
  return modelSelectionsEqual(current, next) ? null : next;
}
