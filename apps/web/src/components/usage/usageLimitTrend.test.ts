import { ProviderDriverKind, ProviderInstanceId, type UsageLimitHistory } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildUsageLimitTrend,
  forecastUsageWindow,
  limitLeftAt,
  usedPerDay,
} from "./usageLimitTrend";

const SINCE = Date.parse("2026-10-10T00:00:00.000Z");
const NOW = Date.parse("2026-10-11T00:00:00.000Z");

const point = (instanceId: string, at: string, usedPercent: number) => ({
  at,
  instanceId: ProviderInstanceId.make(instanceId),
  windowId: "weekly",
  kind: "weekly" as const,
  label: "Weekly",
  usedPercent,
});

const providers = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Work",
  },
];

describe("buildUsageLimitTrend", () => {
  it("draws a stepped line that holds each reading until the next one", () => {
    const history: UsageLimitHistory = {
      points: [
        point("codex", "2026-10-10T06:00:00.000Z", 20),
        point("codex", "2026-10-10T18:00:00.000Z", 60),
      ],
      resets: [],
    };
    const [account] = buildUsageLimitTrend({ history, providers, sinceMs: SINCE, nowMs: NOW });
    expect(account?.name).toBe("Work");
    expect(account?.lines).toEqual([
      {
        windowId: "weekly",
        label: "Weekly",
        kind: "weekly",
        remainingPercent: 40,
        path: "25,20 75,20 75,60 100,60",
        resetMarks: [],
        unusedAtResets: 0,
        usedPerDay: [40],
      },
    ]);
  });

  it("leaves the five-hour session window and its resets out", () => {
    const session = {
      ...point("codex", "2026-10-10T06:00:00.000Z", 80),
      windowId: "session",
      kind: "session" as const,
      label: "Session",
    };
    const reset = (windowId: string, kind: "session" | "weekly") => ({
      at: "2026-10-10T12:00:00.000Z",
      instanceId: ProviderInstanceId.make("codex"),
      windowId,
      kind,
      label: kind === "session" ? "Session" : "Weekly",
      usedPercentBefore: 20,
      unusedPercentBefore: 80,
      usedPercentAfter: 0,
      lastSeenBeforeAt: "2026-10-10T11:00:00.000Z",
      ahead: false,
    });
    const history: UsageLimitHistory = {
      points: [session, point("codex", "2026-10-10T06:00:00.000Z", 20)],
      resets: [reset("session", "session"), reset("weekly", "weekly")],
    };
    const [account] = buildUsageLimitTrend({ history, providers, sinceMs: SINCE, nowMs: NOW });
    expect(account?.lines.map((line) => line.label)).toEqual(["Weekly"]);
    expect(account?.resets.map((entry) => entry.label)).toEqual(["Weekly"]);
    // An account that only has a session window has nothing to show.
    expect(
      buildUsageLimitTrend({
        history: { points: [session], resets: [reset("session", "session")] },
        providers,
        sinceMs: SINCE,
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("keeps the history of an account the server no longer lists, after the known ones", () => {
    const history: UsageLimitHistory = {
      points: [
        point("codex_old", "2026-10-10T06:00:00.000Z", 5),
        point("codex", "2026-10-10T06:00:00.000Z", 20),
      ],
      resets: [],
    };
    expect(
      buildUsageLimitTrend({ history, providers, sinceMs: SINCE, nowMs: NOW }).map(
        (account) => account.name,
      ),
    ).toEqual(["Work", "codex_old"]);
  });

  it("lists an account's resets newest first", () => {
    const reset = (at: string, unusedPercentBefore: number) => ({
      at,
      instanceId: ProviderInstanceId.make("codex"),
      windowId: "weekly",
      kind: "weekly" as const,
      label: "Weekly",
      usedPercentBefore: 100 - unusedPercentBefore,
      unusedPercentBefore,
      usedPercentAfter: 0,
      lastSeenBeforeAt: at,
      ahead: true,
    });
    const history: UsageLimitHistory = {
      points: [point("codex", "2026-10-10T06:00:00.000Z", 20)],
      resets: [reset("2026-10-10T08:00:00.000Z", 38), reset("2026-10-10T20:00:00.000Z", 12)],
    };
    const [account] = buildUsageLimitTrend({ history, providers, sinceMs: SINCE, nowMs: NOW });
    expect(account?.resets.map((entry) => entry.unusedPercentBefore)).toEqual([12, 38]);
  });
});

describe("buildUsageLimitTrend subscriptions", () => {
  const claude = (instanceId: string, email: string) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: instanceId,
    auth: { status: "authenticated" as const, email },
  });
  const reading = (instanceId: string, account: string, at: string, usedPercent: number) => ({
    ...point(instanceId, at, usedPercent),
    driver: ProviderDriverKind.make("claudeAgent"),
    account,
  });

  it("splits an instance that switched accounts and joins instances on one account", () => {
    const history: UsageLimitHistory = {
      points: [
        reading("claudeAgent", "home@example.com", "2026-10-10T06:00:00.000Z", 20),
        reading("claudeAgent", "work@example.com", "2026-10-10T08:00:00.000Z", 70),
        reading("claude_work", "work@example.com", "2026-10-10T09:00:00.000Z", 71),
      ],
      resets: [],
    };
    const accounts = buildUsageLimitTrend({
      history,
      providers: [
        claude("claudeAgent", "home@example.com"),
        claude("claude_work", "work@example.com"),
      ],
      sinceMs: SINCE,
      nowMs: NOW,
    });
    expect(accounts.map((account) => [account.name, account.lines[0]?.remainingPercent])).toEqual([
      ["Claude · home@example.com", 80],
      ["Claude · work@example.com", 29],
    ]);
  });

  it("does not hand an account's history to the instance that switched away from it", () => {
    const history: UsageLimitHistory = {
      points: [
        reading("claudeAgent", "old@example.com", "2026-10-10T06:00:00.000Z", 40),
        reading("claudeAgent", "new@example.com", "2026-10-10T08:00:00.000Z", 10),
      ],
      resets: [],
    };
    const accounts = buildUsageLimitTrend({
      history,
      providers: [claude("claudeAgent", "New@Example.com")],
      sinceMs: SINCE,
      nowMs: NOW,
    });
    expect(accounts.map((account) => [account.name, account.instanceId])).toEqual([
      ["Claude · new@example.com", "claudeAgent"],
      ["Claude · old@example.com", "claudeAgent"],
    ]);
  });

  it("lists only weekly resets", () => {
    const reset = (kind: "weekly" | "monthly") => ({
      at: "2026-10-10T12:00:00.000Z",
      instanceId: ProviderInstanceId.make("codex"),
      windowId: "weekly",
      kind,
      label: kind === "weekly" ? "Weekly" : "Monthly",
      usedPercentBefore: 20,
      unusedPercentBefore: 80,
      usedPercentAfter: 0,
      lastSeenBeforeAt: "2026-10-10T11:00:00.000Z",
      ahead: false,
    });
    const history: UsageLimitHistory = {
      points: [point("codex", "2026-10-10T06:00:00.000Z", 20)],
      resets: [reset("monthly"), reset("weekly")],
    };
    const [account] = buildUsageLimitTrend({ history, providers, sinceMs: SINCE, nowMs: NOW });
    expect(account?.resets.map((entry) => entry.kind)).toEqual(["weekly"]);
  });
});

describe("forecastUsageWindow", () => {
  const RESET = "2026-10-12T00:00:00.000Z";
  const reading = (at: string, usedPercent: number, resetsAt: string | null = RESET) => ({
    ...point("codex", at, usedPercent),
    ...(resetsAt === null ? {} : { resetsAt }),
  });

  it("says when the allowance runs out before the reset", () => {
    // 60 points in 12 hours: the remaining 40 are gone 8 hours from now.
    expect(
      forecastUsageWindow(
        [reading("2026-10-10T12:00:00.000Z", 0), reading("2026-10-10T23:00:00.000Z", 60)],
        NOW,
      ),
    ).toEqual({ type: "runs-out", at: "2026-10-11T08:00:00.000Z", resetsAt: RESET });
  });

  it("says what stays unused when the pace is slow enough", () => {
    // 12 points in 12 hours: 24 more by the reset a day later, 36 used, 64 unused.
    expect(
      forecastUsageWindow(
        [reading("2026-10-10T12:00:00.000Z", 0), reading("2026-10-10T23:00:00.000Z", 12)],
        NOW,
      ),
    ).toEqual({ type: "lasts", unusedPercent: 64, resetsAt: RESET });
  });

  it("measures the pace from the last reset, not from before it", () => {
    expect(
      forecastUsageWindow(
        [
          reading("2026-10-10T00:00:00.000Z", 90),
          reading("2026-10-10T12:00:00.000Z", 0),
          reading("2026-10-10T23:00:00.000Z", 12),
        ],
        NOW,
      ),
    ).toEqual({ type: "lasts", unusedPercent: 64, resetsAt: RESET });
  });

  it("stays silent without a reset ahead or with too little of the cycle recorded", () => {
    expect(forecastUsageWindow([reading("2026-10-10T12:00:00.000Z", 10, null)], NOW)).toBeNull();
    expect(
      forecastUsageWindow(
        [reading("2026-10-10T12:00:00.000Z", 10, "2026-10-10T20:00:00.000Z")],
        NOW,
      ),
    ).toBeNull();
    expect(forecastUsageWindow([reading("2026-10-10T23:30:00.000Z", 10)], NOW)).toBeNull();
    expect(forecastUsageWindow([], NOW)).toBeNull();
  });
});

describe("usedPerDay", () => {
  it("counts each rise on its day and a reset as nothing", () => {
    const since = Date.parse("2026-10-09T00:00:00.000Z");
    expect(
      usedPerDay(
        [
          point("codex", "2026-10-09T06:00:00.000Z", 10),
          point("codex", "2026-10-09T18:00:00.000Z", 30),
          point("codex", "2026-10-10T03:00:00.000Z", 0),
          point("codex", "2026-10-10T20:00:00.000Z", 25),
        ],
        since,
        NOW,
      ),
    ).toEqual([20, 25]);
  });
});

describe("resets in the trend", () => {
  it("marks where a window reset and adds up what was left unused", () => {
    const history: UsageLimitHistory = {
      points: [
        point("codex", "2026-10-10T06:00:00.000Z", 70),
        point("codex", "2026-10-10T12:00:00.000Z", 0),
      ],
      resets: [
        {
          at: "2026-10-10T12:00:00.000Z",
          instanceId: ProviderInstanceId.make("codex"),
          windowId: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercentBefore: 70,
          unusedPercentBefore: 30,
          usedPercentAfter: 0,
          lastSeenBeforeAt: "2026-10-10T06:00:00.000Z",
          ahead: true,
        },
      ],
    };
    const [account] = buildUsageLimitTrend({ history, providers, sinceMs: SINCE, nowMs: NOW });
    expect(account?.lines[0]?.resetMarks).toEqual([50]);
    expect(account?.lines[0]?.unusedAtResets).toBe(30);
  });
});

describe("limitLeftAt", () => {
  const instanceId = ProviderInstanceId.make("codex_stark_cli");
  const point = (at: string, kind: "weekly" | "session", usedPercent: number, resetsAt?: string) =>
    ({
      at,
      instanceId,
      windowId: kind,
      kind,
      label: kind === "weekly" ? "Weekly" : "Session",
      usedPercent,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    }) as UsageLimitHistory["points"][number];
  const points = [
    point("2026-10-12T08:00:00.000Z", "weekly", 40, "2026-10-18T04:00:00.000Z"),
    point("2026-10-12T09:00:00.000Z", "session", 90),
    point("2026-10-12T12:00:00.000Z", "weekly", 68, "2026-10-18T04:00:00.000Z"),
  ];

  it("takes the last long-window reading before the moment, not the session window", () => {
    expect(limitLeftAt(points, instanceId, Date.parse("2026-10-12T10:00:00.000Z"))).toBe(
      "Weekly 60% left",
    );
    expect(limitLeftAt(points, instanceId, Date.parse("2026-10-12T13:00:00.000Z"))).toBe(
      "Weekly 32% left",
    );
  });

  it("says nothing without a reading, for another account, or after the window reset", () => {
    expect(limitLeftAt(points, instanceId, Date.parse("2026-10-12T07:00:00.000Z"))).toBeNull();
    expect(limitLeftAt(points, "claudeAgent", Date.parse("2026-10-12T13:00:00.000Z"))).toBeNull();
    expect(limitLeftAt(points, instanceId, Date.parse("2026-10-19T00:00:00.000Z"))).toBeNull();
  });
});
