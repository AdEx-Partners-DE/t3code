import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { planPortfolioNudge } from "./portfolioNudge.ts";

type Thread = Parameters<typeof planPortfolioNudge>[0]["threads"][number];
const at = (iso: string) => DateTime.makeUnsafe(iso);
const NOW = Date.parse("2026-10-11T12:00:00.000Z");

const thread = (id: string, overrides: Partial<Thread> = {}): Thread =>
  ({
    id: ThreadId.make(id),
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    activeRunId: null,
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    status: "completed",
    snoozedUntil: null,
    latestRunId: RunId.make(`run:${id}:1`),
    latestRunCompletedAt: at("2026-10-11T11:00:00.000Z"),
    modelSelection: { instanceId: "codex", model: "gpt-6" },
    ...overrides,
  }) as Thread;

const schedule = { maxRuns: 20, minPauseMs: 60_000, maxParallel: 2 } as const;
const ids = (plan: ReturnType<typeof planPortfolioNudge<Thread>>) =>
  plan.targets.map((entry) => entry.id as string);

describe("planPortfolioNudge", () => {
  it("fills the free slots with the most recently finished standing threads", () => {
    const plan = planPortfolioNudge({
      schedule,
      threads: [
        thread("old", { latestRunCompletedAt: at("2026-10-10T09:00:00.000Z") }),
        thread("new", { latestRunCompletedAt: at("2026-10-11T11:30:00.000Z") }),
        thread("mid"),
      ],
      nowMs: NOW,
    });
    expect(ids(plan)).toEqual(["new", "mid"]);
  });

  it("never sends to a thread the task leaves out", () => {
    const plan = planPortfolioNudge({
      schedule: { ...schedule, excludeThreadIds: [ThreadId.make("new")] },
      threads: [
        thread("old", { latestRunCompletedAt: at("2026-10-10T09:00:00.000Z") }),
        thread("new", { latestRunCompletedAt: at("2026-10-11T11:30:00.000Z") }),
      ],
      nowMs: NOW,
    });
    expect(ids(plan)).toEqual(["old"]);
  });

  it("counts threads already at work against the cap", () => {
    const threads = [
      thread("busy", { activeRunId: RunId.make("run:busy:2") }),
      thread("a"),
      thread("b"),
    ];
    expect(ids(planPortfolioNudge({ schedule, threads, nowMs: NOW }))).toEqual(["a"]);
    const full = [...threads, thread("busy2", { activityRunStatus: "running" })];
    expect(planPortfolioNudge({ schedule, threads: full, nowMs: NOW }).targets).toEqual([]);
  });

  it("does not send to a thread twice for the same finished run", () => {
    const plan = planPortfolioNudge({
      schedule: { ...schedule, nudged: { a: "run:a:1", gone: "run:gone:1" } },
      threads: [thread("a"), thread("b")],
      nowMs: NOW,
    });
    expect(ids(plan)).toEqual(["b"]);
    // A thread that is no longer open drops out of the memory.
    expect(plan.remembered).toEqual({ a: "run:a:1" });
    // Once the thread has finished another run, it is due again.
    const again = planPortfolioNudge({
      schedule: { ...schedule, nudged: { a: "run:a:1" } },
      threads: [thread("a", { latestRunId: RunId.make("run:a:2") })],
      nowMs: NOW,
    });
    expect(ids(again)).toEqual(["a"]);
  });

  it("waits out the pause after a thread's run and stops at the run limit", () => {
    const fresh = thread("fresh", { latestRunCompletedAt: at("2026-10-11T11:59:30.000Z") });
    expect(planPortfolioNudge({ schedule, threads: [fresh], nowMs: NOW }).targets).toEqual([]);
    const spent = planPortfolioNudge({
      schedule: { ...schedule, runsUsed: 20 },
      threads: [thread("a")],
      nowMs: NOW,
    });
    expect(spent.targets).toEqual([]);
    const oneLeft = planPortfolioNudge({
      schedule: { ...schedule, runsUsed: 19 },
      threads: [thread("a"), thread("b")],
      nowMs: NOW,
    });
    expect(oneLeft.targets).toHaveLength(1);
  });

  it("leaves settled, snoozed, waiting and subagent threads alone", () => {
    const plan = planPortfolioNudge({
      schedule,
      threads: [
        thread("settled", { settledOverride: "settled" }),
        thread("snoozed", { snoozedUntil: at("2026-10-11T13:00:00.000Z") }),
        thread("failed", { status: "failed" }),
        thread("sub", { lineage: { relationshipToParent: "subagent" } as Thread["lineage"] }),
      ],
      nowMs: NOW,
    });
    expect(plan.targets).toEqual([]);
  });
});
