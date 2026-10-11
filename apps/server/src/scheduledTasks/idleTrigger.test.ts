import { describe, expect, it } from "@effect/vitest";
import { RunId, RuntimeRequestId, type ScheduledTaskIdleSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { decideIdleTrigger, type IdleTriggerThread } from "./idleTrigger.ts";

const at = (iso: string) => Date.parse(iso);
const ARMED = at("2026-10-11T08:00:00.000Z");
const schedule: ScheduledTaskIdleSchedule = { type: "idle", maxRuns: 3, minPauseMs: 60_000 };

function thread(overrides: Partial<IdleTriggerThread> = {}): IdleTriggerThread {
  return {
    activeRunId: null,
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    latestRunCompletedAt: DateTime.makeUnsafe("2026-10-11T08:10:00.000Z"),
    ...overrides,
  };
}

function decide(
  overrides: Partial<Parameters<typeof decideIdleTrigger>[0]> = {},
): ReturnType<typeof decideIdleTrigger> {
  return decideIdleTrigger({
    schedule,
    thread: thread(),
    runCount: 0,
    armedAtMs: ARMED,
    lastRunAtMs: null,
    nowMs: at("2026-10-11T08:12:00.000Z"),
    ...overrides,
  });
}

describe("decideIdleTrigger", () => {
  it("fires once the thread has finished a run and the pause has passed", () => {
    expect(decide()).toEqual({ type: "fire" });
  });

  it("waits while a run is active or still winding down", () => {
    expect(decide({ thread: thread({ activeRunId: RunId.make("run:1") }) })).toEqual({
      type: "wait",
      reason: "busy",
    });
    expect(decide({ thread: thread({ activityRunStatus: "waiting" }) })).toEqual({
      type: "wait",
      reason: "busy",
    });
  });

  it("does not nudge an agent that waits for an approval or an answer", () => {
    expect(
      decide({
        thread: thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request:1"),
            kind: "command",
            createdAt: DateTime.makeUnsafe("2026-10-11T08:09:00.000Z"),
          },
        }),
      }),
    ).toEqual({ type: "wait", reason: "waiting-on-user" });
  });

  it("ignores a run that ended before the task was armed", () => {
    expect(
      decide({
        thread: thread({ latestRunCompletedAt: DateTime.makeUnsafe("2026-10-11T07:00:00.000Z") }),
      }),
    ).toEqual({ type: "wait", reason: "no-finished-run" });
    expect(decide({ thread: thread({ latestRunCompletedAt: null }) })).toEqual({
      type: "wait",
      reason: "no-finished-run",
    });
  });

  it("keeps the minimum pause after the run ended and after its own last start", () => {
    expect(decide({ nowMs: at("2026-10-11T08:10:30.000Z") })).toEqual({
      type: "wait",
      reason: "pause",
    });
    expect(decide({ lastRunAtMs: at("2026-10-11T08:11:30.000Z") })).toEqual({
      type: "wait",
      reason: "pause",
    });
  });

  it("stops for good once the runs are used up, whatever the thread is doing", () => {
    expect(decide({ runCount: 3 })).toEqual({ type: "exhausted" });
    expect(decide({ runCount: 3, thread: thread({ activeRunId: RunId.make("run:1") }) })).toEqual({
      type: "exhausted",
    });
  });
});
