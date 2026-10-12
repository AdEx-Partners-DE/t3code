import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { UPDATE_HOLD_MAX_MS, updateHoldEndsAt } from "./updateHold.ts";

const at = Date.parse("2026-10-12T10:00:00.000Z");
const marker = (minutes: number) =>
  JSON.stringify({
    at: DateTime.formatIso(DateTime.makeUnsafe(at)),
    until: DateTime.formatIso(DateTime.makeUnsafe(at + minutes * 60_000)),
  });

describe("updateHoldEndsAt", () => {
  it("holds until the marker's own end", () => {
    expect(updateHoldEndsAt(marker(10), at + 60_000)).toBe(at + 10 * 60_000);
    expect(updateHoldEndsAt(marker(10), at + 10 * 60_000)).toBeNull();
  });

  it("never holds longer than the cap, whatever the marker asks for", () => {
    expect(updateHoldEndsAt(marker(600), at + 60_000)).toBe(at + UPDATE_HOLD_MAX_MS);
    expect(updateHoldEndsAt(marker(600), at + UPDATE_HOLD_MAX_MS)).toBeNull();
  });

  it("does not hold on a marker it cannot read or one from the future", () => {
    expect(updateHoldEndsAt("", at)).toBeNull();
    expect(updateHoldEndsAt("{", at)).toBeNull();
    expect(updateHoldEndsAt(JSON.stringify({ at: "soon", until: "later" }), at)).toBeNull();
    expect(updateHoldEndsAt(marker(10), at - 1)).toBeNull();
  });
});
