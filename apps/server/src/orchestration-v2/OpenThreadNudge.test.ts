import { describe, expect, it } from "@effect/vitest";
import { RunId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { nudgeTargets, standsStill } from "./OpenThreadNudge.ts";

type Thread = Parameters<typeof standsStill>[0];
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
    latestRunId: RunId.make(`run:${id}`),
    latestRunCompletedAt: at("2026-10-11T10:00:00.000Z"),
    ...overrides,
  }) as Thread;

describe("standsStill", () => {
  it("takes a thread that finished a turn and waits for the next message", () => {
    expect(standsStill(thread("a"), NOW)).toBe(true);
    expect(standsStill(thread("a", { status: "interrupted" }), NOW)).toBe(true);
  });

  it("leaves a thread alone that works, waits on an answer, failed or never ran", () => {
    expect(standsStill(thread("a", { activeRunId: RunId.make("run:x") }), NOW)).toBe(false);
    expect(standsStill(thread("a", { activityRunStatus: "waiting" }), NOW)).toBe(false);
    expect(
      standsStill(
        thread("a", {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request:1"),
            kind: "user_input",
            createdAt: at("2026-10-11T11:00:00.000Z"),
          },
        }),
        NOW,
      ),
    ).toBe(false);
    expect(standsStill(thread("a", { status: "failed" }), NOW)).toBe(false);
    expect(standsStill(thread("a", { latestRunId: null }), NOW)).toBe(false);
  });

  it("leaves snoozed, settled and subagent threads alone", () => {
    expect(standsStill(thread("a", { snoozedUntil: at("2026-10-11T13:00:00.000Z") }), NOW)).toBe(
      false,
    );
    expect(standsStill(thread("a", { snoozedUntil: at("2026-10-11T11:00:00.000Z") }), NOW)).toBe(
      true,
    );
    expect(standsStill(thread("a", { settledOverride: "settled" }), NOW)).toBe(false);
    expect(
      standsStill(
        thread("a", { lineage: { relationshipToParent: "subagent" } as Thread["lineage"] }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("nudgeTargets", () => {
  it("takes the most recently finished threads up to the limit and counts all that stand still", () => {
    const result = nudgeTargets(
      [
        thread("old", { latestRunCompletedAt: at("2026-10-10T10:00:00.000Z") }),
        thread("busy", { activeRunId: RunId.make("run:x") }),
        thread("new", { latestRunCompletedAt: at("2026-10-11T11:30:00.000Z") }),
        thread("mid", { latestRunCompletedAt: at("2026-10-11T09:00:00.000Z") }),
      ],
      NOW,
      2,
    );
    expect(result.still).toBe(3);
    expect(result.targets.map((entry) => entry.id)).toEqual(["new", "mid"]);
  });
});
