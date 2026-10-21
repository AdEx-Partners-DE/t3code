import { describe, expect, it } from "vite-plus/test";

import { normalizeCliError } from "./textGenerationUtils.ts";
import { buildThreadChecklistPrompt } from "./textGenerationPrompts.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildThreadChecklistPrompt", () => {
  it("marks the statuses the user set, so a rewrite keeps them", () => {
    const { prompt } = buildThreadChecklistPrompt({
      transcript: "[1] user: deploy it",
      previous: [
        { text: "Deploy the fix", status: "done", setByUser: true },
        { text: "Write docs", status: "open" },
      ],
    });
    expect(prompt).toContain("- [done, set by the user] Deploy the fix");
    expect(prompt).toContain("- [open] Write docs");
  });
});
