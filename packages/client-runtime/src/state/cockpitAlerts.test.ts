import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { deriveCockpitAlerts, formatTokens, formatWait } from "./cockpitAlerts.ts";

const nowMs = Date.parse("2026-10-14T10:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(nowMs - minutes * 60_000).toISOString();
const asking = ThreadId.make("asking");
const silent = ThreadId.make("silent");
const busy = ThreadId.make("busy");
const long = ThreadId.make("long");

describe("deriveCockpitAlerts", () => {
  it("says nothing without an overview", () => {
    expect(deriveCockpitAlerts(null, nowMs)).toEqual({
      updateHoldMs: null,
      questions: null,
      quietRuns: null,
      heavyContexts: null,
      waitingQueues: null,
    });
  });

  it("counts a silent run that waits for an answer as a question, not as quiet", () => {
    const alerts = deriveCockpitAlerts(
      {
        pendingQuestions: [{ threadId: asking, since: minutesAgo(30) }],
        activeRuns: [
          { threadId: asking, lastEventAt: minutesAgo(30) },
          { threadId: silent, lastEventAt: minutesAgo(12) },
          { threadId: busy, lastEventAt: minutesAgo(1) },
        ],
      },
      nowMs,
    );
    expect(alerts.questions).toEqual({ threadIds: new Set([asking]), longestMs: 30 * 60_000 });
    expect(alerts.quietRuns).toEqual({ threadIds: new Set([silent]), longestMs: 12 * 60_000 });
  });

  it("names the threads over the context threshold and the largest of them", () => {
    const alerts = deriveCockpitAlerts(
      {
        contextLoads: [
          { threadId: long, usedTokens: 955_000, maxTokens: 1_000_000 },
          { threadId: busy, usedTokens: 120_000 },
        ],
      },
      nowMs,
    );
    expect(alerts.heavyContexts).toEqual({ threadIds: new Set([long]), largestTokens: 955_000 });
  });

  it("adds up waiting messages and marks a queue that waited an hour", () => {
    const alerts = deriveCockpitAlerts(
      {
        waitingQueues: [
          { threadId: busy, waiting: 2, held: 0, oldestQueuedAt: minutesAgo(70) },
          { threadId: long, waiting: 1, held: 1, oldestQueuedAt: minutesAgo(5) },
        ],
      },
      nowMs,
    );
    expect(alerts.waitingQueues).toEqual({
      threadIds: new Set([busy, long]),
      messages: 3,
      oldestMs: 70 * 60_000,
      stale: true,
    });
  });

  it("reports an update hold only while it lasts", () => {
    expect(
      deriveCockpitAlerts({ tasksHeldForUpdateUntil: minutesAgo(-8) }, nowMs).updateHoldMs,
    ).toBe(8 * 60_000);
    expect(
      deriveCockpitAlerts({ tasksHeldForUpdateUntil: minutesAgo(1) }, nowMs).updateHoldMs,
    ).toBeNull();
  });
});

describe("cockpit labels", () => {
  it("formats waits and token counts", () => {
    expect(formatWait(12 * 60_000)).toBe("12 min");
    expect(formatWait(150 * 60_000)).toBe("2.5 h");
    expect(formatWait(14 * 3_600_000)).toBe("14 h");
    expect(formatTokens(412_300)).toBe("412k");
    expect(formatTokens(1_240_000)).toBe("1.2M");
  });
});
