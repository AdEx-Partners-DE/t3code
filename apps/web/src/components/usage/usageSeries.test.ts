import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { usageRises } from "./usageSeries";

const WEEK = "2026-10-12T15:00:00.000Z";
const NEXT_WEEK = "2026-10-19T15:00:00.000Z";

const point = (minute: number, usedPercent: number, resetsAt?: string) => ({
  at: new Date(Date.parse("2026-10-12T14:00:00.000Z") + minute * 60_000).toISOString(),
  instanceId: ProviderInstanceId.make("claudeAgent"),
  windowId: "seven_day",
  kind: "weekly" as const,
  label: "Weekly",
  usedPercent,
  ...(resetsAt === undefined ? {} : { resetsAt }),
});

const total = (rises: ReturnType<typeof usageRises>) =>
  rises.reduce((sum, entry) => sum + entry.rise, 0);

describe("usageRises", () => {
  it("counts two probes that alternate a point apart as one point of use", () => {
    const rises = usageRises([
      point(0, 90, WEEK),
      point(1, 91, WEEK),
      point(2, 90, WEEK),
      point(3, 91, WEEK),
      point(4, 90, WEEK),
      point(5, 92, WEEK),
    ]);
    expect(total(rises)).toBe(2);
  });

  it("starts over in a new window without counting the reset", () => {
    const rises = usageRises([
      point(0, 92, WEEK),
      point(70, 0, NEXT_WEEK),
      point(80, 3, NEXT_WEEK),
    ]);
    expect(rises.map((entry) => entry.rise)).toEqual([3]);
  });

  it("starts over after a large drop when no reset time is known", () => {
    const rises = usageRises([point(0, 90), point(60, 0), point(120, 3)]);
    expect(rises.map((entry) => entry.rise)).toEqual([3]);
  });
});
