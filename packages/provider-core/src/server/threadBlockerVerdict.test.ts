import { describe, expect, it } from "@effect/vitest";

import { buildThreadBlockerPrompt, readThreadBlockerVerdict } from "./textGenerationPrompts.ts";

describe("readThreadBlockerVerdict", () => {
  it("sends a thread on only for a clear continue with an instruction", () => {
    expect(
      readThreadBlockerVerdict({
        verdict: "continue",
        instruction: "  Go on with the fix you proposed.  ",
        reason: "asked whether to apply the fix",
      }),
    ).toEqual({
      kind: "sham",
      instruction: "Go on with the fix you proposed.",
      reason: "asked whether to apply the fix",
    });
  });

  it("leaves the thread with the user in every other case", () => {
    expect(
      readThreadBlockerVerdict({
        verdict: "needs_user",
        instruction: null,
        reason: "needs a token",
      }),
    ).toEqual({ kind: "real", reason: "needs a token" });
    // A continue with nothing to say would send an empty message.
    expect(
      readThreadBlockerVerdict({ verdict: "continue", instruction: "   ", reason: "unclear" }),
    ).toEqual({ kind: "real", reason: "unclear" });
    expect(
      readThreadBlockerVerdict({ verdict: "continue", instruction: null, reason: "unclear" }),
    ).toEqual({ kind: "real", reason: "unclear" });
    // A model that ignores an instruction to go on is still asked to stop.
    expect(
      readThreadBlockerVerdict({
        verdict: "needs_user",
        instruction: "Delete the branch.",
        reason: "cannot be undone",
      }),
    ).toEqual({ kind: "real", reason: "cannot be undone" });
  });
});

describe("buildThreadBlockerPrompt", () => {
  it("keeps the end of a long reply, where the question is", () => {
    const { prompt } = buildThreadBlockerPrompt({
      lastRequest: "",
      lastReply: `${"x".repeat(20_000)} Shall I continue?`,
    });
    expect(prompt).toContain("Shall I continue?");
    expect(prompt).toContain("(not known)");
    expect(prompt.length).toBeLessThan(9_000);
  });
});
