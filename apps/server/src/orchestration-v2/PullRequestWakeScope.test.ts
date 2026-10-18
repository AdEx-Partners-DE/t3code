import { describe, expect, it } from "@effect/vitest";

import { wakeConcernsOnly } from "./PullRequestWakeScope.ts";

const url = "https://github.com/pingdotgg/t3code/pull/7";
const wake = (summary: string, text = `Update on pull request #7 (${url})`) => ({
  text,
  notification: { source: { kind: "monitor" as const }, outcome: "updated" as const, summary },
});

describe("wakeConcernsOnly", () => {
  it("takes a wake, joined or not, that reports on this pull request alone", () => {
    expect(wakeConcernsOnly(wake("#7: checks passed"), 7, url)).toBe(true);
    expect(wakeConcernsOnly(wake("#7: new comments; #7: checks passed"), 7, url)).toBe(true);
  });

  it("keeps a wake that also reports on another pull request or names none", () => {
    expect(wakeConcernsOnly(wake("#7: checks passed; #72: new comments"), 7, url)).toBe(false);
    expect(wakeConcernsOnly(wake("#72: checks passed"), 7, url)).toBe(false);
    expect(wakeConcernsOnly(wake("checks passed"), 7, url)).toBe(false);
    expect(wakeConcernsOnly({ text: url }, 7, url)).toBe(false);
  });

  it("keeps a wake about the same number in another repository", () => {
    expect(
      wakeConcernsOnly(
        wake("#7: checks passed", "Update on pull request #7 (https://github.com/acme/app/pull/7)"),
        7,
        url,
      ),
    ).toBe(false);
  });
});
