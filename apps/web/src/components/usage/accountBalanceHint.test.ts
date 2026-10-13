import { describe, expect, it } from "vite-plus/test";

import { accountBalanceHint } from "./accountBalanceHint";
import type { UsageLimitForecast, UsageLimitTrendAccount } from "./usageLimitTrend";

const account = (
  instanceId: string,
  forecast: UsageLimitForecast | undefined,
): UsageLimitTrendAccount => ({
  instanceId,
  name: instanceId,
  resets: [],
  lines: [
    {
      windowId: "seven_day",
      label: "Weekly",
      kind: "weekly",
      ...(forecast === undefined ? {} : { forecast }),
      resetMarks: [],
      unusedAtResets: 0,
      usedPerDay: [],
      remainingPercent: 50,
      path: "",
    },
  ],
});

const runsOut: UsageLimitForecast = {
  type: "runs-out",
  at: "2026-10-14T17:00:00.000Z",
  resetsAt: "2026-10-16T12:00:00.000Z",
};
const lasts = (unusedPercent: number): UsageLimitForecast => ({
  type: "lasts",
  unusedPercent,
  resetsAt: "2026-10-19T15:00:00.000Z",
});
const drivers: Record<string, string> = {
  claude_oneneutrino: "claudeAgent",
  claudeAgent: "claudeAgent",
  codex: "codex",
};
const driverOf = (instanceId: string) => drivers[instanceId];

describe("accountBalanceHint", () => {
  it("suggests the like account with the most to spare when the override account runs out first", () => {
    const hint = accountBalanceHint({
      accounts: [
        account("claude_oneneutrino", runsOut),
        account("claudeAgent", lasts(80)),
        account("codex", lasts(95)),
      ],
      overrideInstanceIds: ["claude_oneneutrino"],
      driverOf,
    });
    expect(hint).toEqual({
      from: {
        instanceId: "claude_oneneutrino",
        name: "claude_oneneutrino",
        emptyAt: runsOut.at,
        resetsAt: runsOut.resetsAt,
      },
      to: { instanceId: "claudeAgent", name: "claudeAgent", unusedPercent: 80 },
    });
  });

  it("says nothing while the override account lasts to its reset", () => {
    expect(
      accountBalanceHint({
        accounts: [account("claude_oneneutrino", lasts(10)), account("claudeAgent", lasts(80))],
        overrideInstanceIds: ["claude_oneneutrino"],
        driverOf,
      }),
    ).toBeNull();
  });

  it("says nothing when no like account has enough to spare or a forecast at all", () => {
    expect(
      accountBalanceHint({
        accounts: [
          account("claude_oneneutrino", runsOut),
          account("claudeAgent", lasts(5)),
          account("codex", lasts(95)),
        ],
        overrideInstanceIds: ["claude_oneneutrino"],
        driverOf,
      }),
    ).toBeNull();
    expect(
      accountBalanceHint({
        accounts: [account("claude_oneneutrino", runsOut), account("claudeAgent", undefined)],
        overrideInstanceIds: ["claude_oneneutrino"],
        driverOf,
      }),
    ).toBeNull();
  });

  it("says nothing without a standing override", () => {
    expect(
      accountBalanceHint({
        accounts: [account("claude_oneneutrino", runsOut), account("claudeAgent", lasts(80))],
        overrideInstanceIds: [],
        driverOf,
      }),
    ).toBeNull();
  });
});
