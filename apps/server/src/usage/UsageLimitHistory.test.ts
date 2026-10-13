import { describe, expect, it } from "@effect/vitest";

import { parseUsageLimitHistory } from "./UsageLimitHistory.ts";
import { replayUsageLimitPoints } from "./usageLimitReadings.ts";

const point = (at: string, usedPercent: number, resetsAt: string) =>
  JSON.stringify({
    point: {
      at,
      instanceId: "claudeAgent",
      windowId: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent,
      resetsAt,
    },
  });

describe("parseUsageLimitHistory", () => {
  it("reads past logged resets and works them out again from the readings", () => {
    const loggedReset = JSON.stringify({
      reset: {
        at: "2026-10-12T14:39:00.000Z",
        instanceId: "claudeAgent",
        windowId: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercentBefore: 91,
        unusedPercentBefore: 9,
        usedPercentAfter: 90,
        lastSeenBeforeAt: "2026-10-12T14:38:00.000Z",
        expectedAt: "2026-10-12T15:00:00.000Z",
        ahead: true,
      },
    });
    const contents = [
      point("2026-10-12T14:38:00.000Z", 91, "2026-10-12T15:00:00.401Z"),
      point("2026-10-12T14:39:00.000Z", 90, "2026-10-12T15:00:00.000Z"),
      loggedReset,
      point("2026-10-12T14:58:00.000Z", 92, "2026-10-12T15:00:00.095Z"),
      point("2026-10-12T15:04:00.000Z", 0, "2026-10-19T14:59:59.545Z"),
      "not json",
    ].join("\n");
    const points = parseUsageLimitHistory(contents, Date.parse("2026-10-13T00:00:00.000Z"));
    expect(points).toHaveLength(4);
    expect(
      replayUsageLimitPoints(points).resets.map((reset) => [reset.at, reset.unusedPercentBefore]),
    ).toEqual([["2026-10-12T15:04:00.000Z", 8]]);
  });

  it("drops readings past the retention window", () => {
    const contents = point("2026-01-01T00:00:00.000Z", 10, "2026-01-05T00:00:00.000Z");
    expect(parseUsageLimitHistory(contents, Date.parse("2026-10-13T00:00:00.000Z"))).toEqual([]);
  });
});
