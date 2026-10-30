import type { OrchestrationV2RpcSchemas } from "@t3tools/contracts";

/** What the all-threads overview reports; every part is optional on the wire. */
export type CockpitOverview = Pick<
  (typeof OrchestrationV2RpcSchemas.listThreadChecklists.output)["Type"],
  "waitingQueues" | "activeRuns" | "pendingQuestions" | "contextLoads" | "tasksHeldForUpdateUntil"
>;

/** A queue whose oldest message waited this long is called out. */
const STALE_QUEUE_MS = 60 * 60_000;
/** A run under way with no event for this long is called out. */
const QUIET_RUN_MS = 5 * 60_000;
/**
 * Context a thread may carry before the cockpit suggests compacting it. Every
 * request sends the whole context again, so long threads spend the allowance
 * even when the prompt cache hits.
 */
export const HEAVY_CONTEXT_TOKENS = 300_000;

/** The things across all open threads that want the user's eye, each with the threads concerned. */
export interface CockpitAlerts {
  /** How long an update still keeps tasks back; null when none waits. */
  readonly updateHoldMs: number | null;
  readonly questions: {
    readonly threadIds: ReadonlySet<string>;
    readonly longestMs: number;
  } | null;
  readonly quietRuns: {
    readonly threadIds: ReadonlySet<string>;
    readonly longestMs: number;
  } | null;
  readonly heavyContexts: {
    readonly threadIds: ReadonlySet<string>;
    readonly largestTokens: number;
  } | null;
  readonly waitingQueues: {
    readonly threadIds: ReadonlySet<string>;
    readonly messages: number;
    readonly oldestMs: number;
    readonly stale: boolean;
  } | null;
}

/**
 * Reads the overview into alerts. A run that waits for an answer is silent
 * too, but it does not hang: it counts as a question, not as a quiet run.
 */
export function deriveCockpitAlerts(
  overview: CockpitOverview | null,
  nowMs: number,
): CockpitAlerts {
  const heldUntil = overview?.tasksHeldForUpdateUntil;
  const questions = overview?.pendingQuestions ?? [];
  const asking = new Set<string>(questions.map((question) => question.threadId));
  const quiet = (overview?.activeRuns ?? []).filter(
    (run) => !asking.has(run.threadId) && nowMs - Date.parse(run.lastEventAt) >= QUIET_RUN_MS,
  );
  const heavy = (overview?.contextLoads ?? []).filter(
    (load) => load.usedTokens >= HEAVY_CONTEXT_TOKENS,
  );
  const queues = overview?.waitingQueues ?? [];
  const oldestQueuedMs =
    queues.length === 0
      ? 0
      : nowMs - Math.min(...queues.map((queue) => Date.parse(queue.oldestQueuedAt)));
  return {
    updateHoldMs:
      heldUntil === undefined || Date.parse(heldUntil) <= nowMs
        ? null
        : Date.parse(heldUntil) - nowMs,
    questions:
      questions.length === 0
        ? null
        : {
            threadIds: asking,
            longestMs: nowMs - Math.min(...questions.map((question) => Date.parse(question.since))),
          },
    quietRuns:
      quiet.length === 0
        ? null
        : {
            threadIds: new Set(quiet.map((run) => run.threadId)),
            longestMs: nowMs - Math.min(...quiet.map((run) => Date.parse(run.lastEventAt))),
          },
    heavyContexts:
      heavy.length === 0
        ? null
        : {
            threadIds: new Set(heavy.map((load) => load.threadId)),
            largestTokens: Math.max(...heavy.map((load) => load.usedTokens)),
          },
    waitingQueues:
      queues.length === 0
        ? null
        : {
            threadIds: new Set(queues.map((queue) => queue.threadId)),
            messages: queues.reduce((total, queue) => total + queue.waiting, 0),
            oldestMs: oldestQueuedMs,
            stale: oldestQueuedMs >= STALE_QUEUE_MS,
          },
  };
}

/** A wait as minutes, then hours: "12 min", "2.5 h", "14 h". */
export function formatWait(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 10 ? `${hours.toFixed(1)} h` : `${Math.round(hours)} h`;
}

/** A token count as "412k" or "1.2M". */
export function formatTokens(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : `${Math.round(tokens / 1_000)}k`;
}
