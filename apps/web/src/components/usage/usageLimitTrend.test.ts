import { ProviderDriverKind, ProviderInstanceId, type UsageLimitHistory } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildUsageLimitTrend } from "./usageLimitTrend";

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
        remainingPercent: 40,
        path: "25,20 75,20 75,60 100,60",
      },
    ]);
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
