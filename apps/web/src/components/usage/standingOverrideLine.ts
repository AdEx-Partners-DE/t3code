import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { overriddenModelSelection, type ModelOverride } from "@t3tools/shared/modelOverride";

export interface StandingOverridePart {
  readonly model?: { readonly instanceId: string; readonly model: string } | undefined;
  readonly effort?: string | undefined;
  readonly keepOwnAccount?: boolean | undefined;
}

export interface StandingOverride {
  readonly tasks: StandingOverridePart | null;
  readonly adhoc: StandingOverridePart | null;
}

function describePart(part: StandingOverridePart, nameOf: (instanceId: string) => string): string {
  return [
    part.model === undefined ? null : `${nameOf(part.model.instanceId)} · ${part.model.model}`,
    part.effort === undefined ? null : `thinking ${part.effort}`,
    part.keepOwnAccount === true ? "each on its own account" : null,
  ]
    .filter((text) => text !== null)
    .join(", ");
}

/**
 * The cockpit's line while a standing model override is in force, or null when none is. The
 * override also moves threads that open later, so it has to be visible outside the settings.
 */
export function standingOverrideLine(
  standing: StandingOverride,
  nameOf: (instanceId: string) => string,
): string | null {
  const tasks = standing.tasks === null ? null : describePart(standing.tasks, nameOf);
  const adhoc = standing.adhoc === null ? null : describePart(standing.adhoc, nameOf);
  if (tasks !== null && tasks === adhoc) return `Model rule for all open threads: ${tasks}`;
  const parts = [
    tasks === null ? null : `task threads: ${tasks}`,
    adhoc === null ? null : `other threads: ${adhoc}`,
  ].filter((text) => text !== null);
  return parts.length === 0 ? null : `Model rule for ${parts.join("; ")}`;
}

/**
 * How many of the given open threads the rule would still move, or null when
 * that cannot be told here: the client does not know which threads count as
 * task threads, so a count is only honest while one rule covers both parts.
 */
export function threadsOffModelRule(
  standing: StandingOverride,
  threads: ReadonlyArray<{ readonly modelSelection: ModelSelection }>,
  providers: ReadonlyArray<ServerProvider>,
): number | null {
  const { tasks, adhoc } = standing;
  if (tasks === null || adhoc === null || describeKey(tasks) !== describeKey(adhoc)) return null;
  const override = tasks as ModelOverride;
  return threads.filter(
    (thread) =>
      overriddenModelSelection({ current: thread.modelSelection, override, providers }) !== null,
  ).length;
}

function describeKey(part: StandingOverridePart): string {
  return JSON.stringify([
    part.model?.instanceId ?? null,
    part.model?.model ?? null,
    part.effort ?? null,
    part.keepOwnAccount === true,
  ]);
}
