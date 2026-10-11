import { describe, expect, it } from "@effect/vitest";

import { keepRecentDecisions } from "./decisionLog.ts";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const line = (at: string) => JSON.stringify({ at, kind: "restart-continuation", threadId: "t" });

describe("keepRecentDecisions", () => {
  it("keeps what is younger than the retention and drops the rest", () => {
    const recent = line("2026-10-01T00:00:00.000Z");
    const old = line("2026-08-01T00:00:00.000Z");
    expect(keepRecentDecisions(`${old}\n${recent}\n`, NOW)).toBe(`${recent}\n`);
  });

  it("drops lines it cannot read instead of failing", () => {
    const recent = line("2026-10-10T00:00:00.000Z");
    expect(keepRecentDecisions(`not json\n{"kind":"x"}\n\n${recent}\n`, NOW)).toBe(`${recent}\n`);
  });
});
