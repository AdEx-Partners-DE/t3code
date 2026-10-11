import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildUsageBurn } from "./usageBurn";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");

const point = (
  instanceId: string,
  at: string,
  usedPercent: number,
  kind: "weekly" | "session" = "weekly",
) => ({
  at,
  instanceId: ProviderInstanceId.make(instanceId),
  windowId: kind,
  kind,
  label: kind,
  usedPercent,
});

describe("buildUsageBurn", () => {
  it("counts each rise in the hour of its reading and sums the accounts", () => {
    const burn = buildUsageBurn({
      points: [
        point("a", "2026-10-11T08:10:00.000Z", 10),
        point("a", "2026-10-11T09:30:00.000Z", 14),
        point("a", "2026-10-11T11:40:00.000Z", 20),
        point("b", "2026-10-11T09:00:00.000Z", 50),
        point("b", "2026-10-11T09:45:00.000Z", 51),
      ],
      nowMs: NOW,
      hours: 4,
    });
    expect(burn.perHour).toEqual([0, 5, 0, 6]);
    expect(burn.lastHour).toBe(6);
    expect(burn.peak).toBe(6);
  });

  it("counts a reset as nothing", () => {
    const burn = buildUsageBurn({
      points: [
        point("a", "2026-10-11T09:10:00.000Z", 90),
        point("a", "2026-10-11T10:10:00.000Z", 0),
        point("a", "2026-10-11T11:10:00.000Z", 3),
      ],
      nowMs: NOW,
      hours: 4,
    });
    expect(burn.perHour).toEqual([0, 0, 0, 3]);
  });

  it("ignores the session window of an account that reports a weekly one", () => {
    const burn = buildUsageBurn({
      points: [
        point("a", "2026-10-11T10:10:00.000Z", 10),
        point("a", "2026-10-11T11:10:00.000Z", 12),
        point("a", "2026-10-11T10:10:00.000Z", 20, "session"),
        point("a", "2026-10-11T11:10:00.000Z", 60, "session"),
        point("b", "2026-10-11T10:10:00.000Z", 5, "session"),
        point("b", "2026-10-11T11:10:00.000Z", 9, "session"),
      ],
      nowMs: NOW,
      hours: 2,
    });
    // 2 from a's weekly window, 4 from b, which has only a session window.
    expect(burn.perHour).toEqual([0, 6]);
  });

  it("is flat without readings", () => {
    expect(buildUsageBurn({ points: [], nowMs: NOW, hours: 3 })).toEqual({
      perHour: [0, 0, 0],
      lastHour: 0,
      peak: 0,
    });
  });
});
