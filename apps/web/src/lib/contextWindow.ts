import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2RunAttempt,
} from "@t3tools/contracts";

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** How full the context was when a run ended. */
export interface RunContextUsage {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
}

/**
 * For each run, the context usage its last finished provider turn reported:
 * what the agent knew at the end of that turn. Turns still under way are left
 * out, so the result holds still while a turn streams.
 */
export function contextUsageByRun(
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>,
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "status" | "tokenUsage">>,
): ReadonlyMap<string, RunContextUsage> {
  const runOfAttempt = new Map(attempts.map((attempt) => [attempt.id as string, attempt.runId]));
  const newest = new Map<string, OrchestrationV2ProviderTurnTokenUsage>();
  for (const turn of turns) {
    if (turn.tokenUsage === undefined || turn.runAttemptId === null) continue;
    if (turn.status === "pending" || turn.status === "running") continue;
    const runId = runOfAttempt.get(turn.runAttemptId);
    if (runId === undefined) continue;
    const known = newest.get(runId);
    if (
      known === undefined ||
      Date.parse(turn.tokenUsage.updatedAt) >= Date.parse(known.updatedAt)
    ) {
      newest.set(runId, turn.tokenUsage);
    }
  }
  return new Map(
    [...newest].map(([runId, usage]) => [
      runId,
      { usedTokens: usage.usedTokens, maxTokens: usage.maxTokens ?? null },
    ]),
  );
}

/** "Context 412k of 1M (41%)", or without the share when the limit is unknown. */
export function formatRunContextUsage(usage: RunContextUsage): string {
  const used = formatContextWindowTokens(usage.usedTokens);
  if (usage.maxTokens === null || usage.maxTokens <= 0) return `Context ${used}`;
  const share = Math.round((usage.usedTokens / usage.maxTokens) * 100);
  return `Context ${used} of ${formatContextWindowTokens(usage.maxTokens)} (${share}%)`;
}
