import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { recordUsageLimitReadings, type UsageLimitReadingState } from "./usageLimitReadings.ts";

type Reading = Pick<ServerProvider, "instanceId" | "usageLimits"> &
  Partial<Pick<ServerProvider, "auth">>;

function reading(
  at: string,
  weeklyUsed: number,
  weeklyResetsAt: string | undefined,
  instanceId = "codex",
  email?: string,
): Reading {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    ...(email === undefined ? {} : { auth: { status: "authenticated" as const, email } }),
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
/** A week from the early reset at 2026-10-11T08:05, when Codex starts the new window. */
const EARLY_NEXT_RESET = "2026-10-18T08:04:00.000Z";

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
      [reading("2026-10-11T08:05:00.000Z", 0, EARLY_NEXT_RESET)],
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
        reading("2026-10-11T08:05:00.000Z", 0, EARLY_NEXT_RESET, "codex_personal"),
      ],
    ]);
    expect(resets.map((reset) => [reset.instanceId, reset.unusedPercentBefore])).toEqual([
      ["codex_personal", 95],
    ]);
  });

  it("counts an early reset that keeps the schedule once the window empties", () => {
    const { resets } = replay([
      [reading("2026-10-11T08:00:00.000Z", 40, RESET)],
      [reading("2026-10-11T08:05:00.000Z", 0, RESET)],
    ]);
    expect(resets.map((reset) => [reset.ahead, reset.unusedPercentBefore])).toEqual([[true, 60]]);
  });

  it("does not take two probes that round a point apart for resets", () => {
    const { resets } = replay([
      [reading("2026-10-12T14:38:00.000Z", 91, "2026-10-12T15:00:00.401Z")],
      [reading("2026-10-12T14:39:00.000Z", 90, "2026-10-12T15:00:00.000Z")],
      [reading("2026-10-12T14:40:00.000Z", 91, "2026-10-12T15:00:00.401Z")],
      [reading("2026-10-12T14:41:00.000Z", 90, "2026-10-12T15:00:00.000Z")],
    ]);
    expect(resets).toEqual([]);
  });

  it("keeps one series per account when an instance switches accounts", () => {
    const work = "2026-10-16T12:00:00.000Z";
    const { resets } = replay([
      [reading("2026-10-12T19:00:00.000Z", 22, work, "claude", "work@example.com")],
      [reading("2026-10-12T19:30:00.000Z", 6, NEXT_RESET, "claude", "home@example.com")],
      [reading("2026-10-12T20:00:00.000Z", 23, work, "claude", "work@example.com")],
    ]);
    expect(resets).toEqual([]);
  });

  it("does not take a switch between unnamed accounts for a reset", () => {
    const { resets } = replay([
      [reading("2026-10-12T19:00:00.000Z", 22, "2026-10-16T12:00:00.000Z")],
      [reading("2026-10-12T19:30:00.000Z", 2, "2026-10-19T15:00:00.000Z")],
    ]);
    expect(resets).toEqual([]);
  });

  it("names the subscription a reset belongs to", () => {
    const { resets } = replay([
      [reading("2026-10-11T08:00:00.000Z", 62, RESET, "claude", "home@example.com")],
      [reading("2026-10-11T08:05:00.000Z", 0, EARLY_NEXT_RESET, "claude", "home@example.com")],
    ]);
    expect(resets.map((reset) => reset.account)).toEqual(["home@example.com"]);
  });

  it("skips a reading of a window that had already ended", () => {
    const { points, resets } = replay([
      [reading("2026-10-14T02:03:00.000Z", 1, NEXT_RESET)],
      [reading("2026-10-14T02:20:00.000Z", 97, RESET)],
    ]);
    expect(points.map((point) => point.usedPercent)).toEqual([1]);
    expect(resets).toEqual([]);
  });

  it("keys a subscription by lower-cased email and workspace, joining a read without one", () => {
    const read = (at: string, used: number, email: string, workspaceId?: string): Reading => ({
      ...reading(at, used, RESET, "codex"),
      auth: {
        status: "authenticated",
        email,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      },
    });
    const { points } = replay([
      [read("2026-10-11T08:00:00.000Z", 40, "Me@Example.com", "team")],
      [read("2026-10-11T08:05:00.000Z", 41, "me@example.com")],
      [read("2026-10-11T08:10:00.000Z", 5, "me@example.com", "personal")],
    ]);
    expect(points.map((point) => [point.account, point.workspaceId])).toEqual([
      ["me@example.com", "team"],
      ["me@example.com", "team"],
      ["me@example.com", "personal"],
    ]);
  });

  it("leaves a model's own weekly window out", () => {
    const fable: Reading = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      usageLimits: {
        checkedAt: "2026-10-11T08:00:00.000Z",
        windows: [
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 40, resetsAt: RESET },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 2,
            resetsAt: RESET,
          },
        ],
      },
    };
    expect(replay([[fable]]).points.map((point) => point.windowId)).toEqual(["seven_day"]);
  });
});
