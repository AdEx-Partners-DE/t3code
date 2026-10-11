import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { recordUsageLimitReadings, type UsageLimitReadingState } from "./usageLimitReadings.ts";

type Reading = Pick<ServerProvider, "instanceId" | "usageLimits">;

function reading(
  at: string,
  weeklyUsed: number,
  weeklyResetsAt: string | undefined,
  instanceId = "codex",
): Reading {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    usageLimits: {
      checkedAt: at,
      windows: [
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: weeklyUsed,
          ...(weeklyResetsAt === undefined ? {} : { resetsAt: weeklyResetsAt }),
        },
      ],
    },
  };
}

function replay(readings: ReadonlyArray<ReadonlyArray<Reading>>) {
  let state: UsageLimitReadingState = new Map();
  const points = [];
  const resets = [];
  for (const providers of readings) {
    const delta = recordUsageLimitReadings(state, providers);
    state = delta.state;
    points.push(...delta.points);
    resets.push(...delta.resets);
  }
  return { points, resets };
}

const RESET = "2026-10-14T02:00:00.000Z";
const NEXT_RESET = "2026-10-21T02:00:00.000Z";

describe("recordUsageLimitReadings", () => {
  it("records a point only when a window's reading changes", () => {
    const { points, resets } = replay([
      [reading("2026-10-10T10:00:00.000Z", 40, RESET)],
      [reading("2026-10-10T10:05:00.000Z", 40, RESET)],
      [reading("2026-10-10T10:10:00.000Z", 43, RESET)],
    ]);
    expect(points.map((point) => [point.at, point.usedPercent])).toEqual([
      ["2026-10-10T10:00:00.000Z", 40],
      ["2026-10-10T10:10:00.000Z", 43],
    ]);
    expect(resets).toEqual([]);
  });

  it("does not record a reset time that only wanders by seconds", () => {
    const { points } = replay([
      [reading("2026-10-10T10:00:00.000Z", 40, "2026-10-14T02:00:00.100Z")],
      [reading("2026-10-10T10:05:00.000Z", 40, "2026-10-14T02:00:03.900Z")],
    ]);
    expect(points).toHaveLength(1);
  });

  it("logs an early reset with what was left unused", () => {
    const { resets } = replay([
      [reading("2026-10-11T08:00:00.000Z", 62, RESET)],
      [reading("2026-10-11T08:05:00.000Z", 0, NEXT_RESET)],
    ]);
    expect(resets).toEqual([
      {
        at: "2026-10-11T08:05:00.000Z",
        instanceId: "codex",
        windowId: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercentBefore: 62,
        unusedPercentBefore: 38,
        usedPercentAfter: 0,
        lastSeenBeforeAt: "2026-10-11T08:00:00.000Z",
        expectedAt: RESET,
        ahead: true,
      },
    ]);
  });

  it("treats a reset at its announced time, or without one, as on schedule", () => {
    const onTime = replay([
      [reading("2026-10-14T01:55:00.000Z", 97, RESET)],
      [reading("2026-10-14T02:03:00.000Z", 1, NEXT_RESET)],
    ]);
    expect(onTime.resets.map((reset) => [reset.ahead, reset.unusedPercentBefore])).toEqual([
      [false, 3],
    ]);
    const unknown = replay([
      [reading("2026-10-11T08:00:00.000Z", 50, undefined)],
      [reading("2026-10-11T09:00:00.000Z", 5, undefined)],
    ]);
    expect(unknown.resets.map((reset) => reset.ahead)).toEqual([false]);
  });

  it("ignores failed probes, stale reads, and jitter below one percent", () => {
    const failed: Reading = {
      instanceId: ProviderInstanceId.make("codex"),
      usageLimits: {
        checkedAt: "2026-10-10T10:20:00.000Z",
        windows: [],
        unavailable: { reason: "probeFailed" },
      },
    };
    const { points, resets } = replay([
      [reading("2026-10-10T10:00:00.000Z", 40, RESET)],
      [failed],
      [reading("2026-10-10T09:00:00.000Z", 10, RESET)],
      [reading("2026-10-10T10:30:00.000Z", 39.6, RESET)],
    ]);
    expect(points.map((point) => point.usedPercent)).toEqual([40, 39.6]);
    expect(resets).toEqual([]);
  });

  it("keeps accounts apart", () => {
    const { resets } = replay([
      [
        reading("2026-10-11T08:00:00.000Z", 80, RESET, "codex"),
        reading("2026-10-11T08:00:00.000Z", 5, RESET, "codex_personal"),
      ],
      [
        reading("2026-10-11T08:05:00.000Z", 81, RESET, "codex"),
        reading("2026-10-11T08:05:00.000Z", 0, NEXT_RESET, "codex_personal"),
      ],
    ]);
    expect(resets.map((reset) => [reset.instanceId, reset.unusedPercentBefore])).toEqual([
      ["codex_personal", 95],
    ]);
  });
});
