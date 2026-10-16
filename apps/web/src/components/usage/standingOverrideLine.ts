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
