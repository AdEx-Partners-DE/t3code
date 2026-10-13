import { describe, expect, it } from "@effect/vitest";
import { MessageId, RunId, ScheduledTaskId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  buildChecklistTranscript,
  buildChecklistTranscriptWithSources,
  checklistIsCurrent,
  latestFinishedRunId,
  messagesOfFinishedTurns,
  turnsFinishedSince,
} from "./threadChecklistTranscript.ts";

type Message = Parameters<typeof buildChecklistTranscript>[0][number];

let counter = 0;
const message = (
  role: Message["role"],
  text: string,
  run: string | null,
  overrides: Partial<Message> = {},
): Message => {
  counter += 1;
  return {
    id: MessageId.make(`message:${counter}`),
    role,
    text,
    runId: run === null ? null : RunId.make(run),
    createdAt: DateTime.makeUnsafe("2026-10-11T08:00:00.000Z"),
    ...overrides,
  } as Message;
};

describe("buildChecklistTranscript", () => {
  it("keeps what the user wrote and the closing reply of each turn", () => {
    const transcript = buildChecklistTranscript(
      [
        message("user", "Fix the build.", "run:1"),
        message("assistant", "Looking at it.", "run:1"),
        message("assistant", "Fixed: the lockfile was stale.", "run:1"),
        message("user", "Thanks. Also bump the version.", "run:2"),
        message("assistant", "Bumped to 1.2.0.", "run:2"),
      ],
      10_000,
    );
    expect(transcript.split("\n")).toEqual([
      "[1] USER 2026-10-11 08:00: Fix the build.",
      "[2] AGENT 2026-10-11 08:00: Fixed: the lockfile was stale.",
      "[3] USER 2026-10-11 08:00: Thanks. Also bump the version.",
      "[4] AGENT 2026-10-11 08:00: Bumped to 1.2.0.",
    ]);
  });

  it("says which message each numbered entry came from", () => {
    const ask = message("user", "Fix the build.", "run:1");
    const interim = message("assistant", "Looking at it.", "run:1");
    const closing = message("assistant", "Fixed.", "run:1");
    const { transcript, messageIdOfEntry } = buildChecklistTranscriptWithSources(
      [ask, interim, closing],
      10_000,
    );
    expect(transcript.split("\n")).toHaveLength(2);
    // Entry 2 is the turn's closing reply, not the interim one.
    expect([...messageIdOfEntry]).toEqual([
      [1, ask.id],
      [2, closing.id],
    ]);
  });

  it("writes a repeated automation prompt once and leaves server notices out", () => {
    const scheduledTaskId = ScheduledTaskId.make("task:1");
    const transcript = buildChecklistTranscript(
      [
        message("user", "Check the mission state.", "run:1", { scheduledTaskId }),
        message("assistant", "Nothing new.", "run:1"),
        message("user", "Check the mission state.", "run:2", { scheduledTaskId }),
        message("assistant", "Still nothing.", "run:2"),
        message("user", "Continue where you left off.", "run:3", {
          notification: {} as Message["notification"],
        }),
      ],
      10_000,
    );
    expect(transcript.split("\n")).toEqual([
      "[1] AUTOMATION 2026-10-11 08:00: Check the mission state.",
      "[2] AGENT 2026-10-11 08:00: Nothing new.",
      "[3] AUTOMATION 2026-10-11 08:00: (same prompt as entry 1)",
      "[4] AGENT 2026-10-11 08:00: Still nothing.",
    ]);
  });

  it("gives up the agent's oldest replies before any word of the user", () => {
    const long = "x".repeat(900);
    const transcript = buildChecklistTranscript(
      [
        message("user", "First ask.", "run:1"),
        message("assistant", long, "run:1"),
        message("user", "Second ask.", "run:2"),
        message("assistant", long, "run:2"),
        message("user", "Third ask.", "run:3"),
        message("assistant", "Short closing reply.", "run:3"),
      ],
      1_200,
    );
    expect(transcript).toContain("First ask.");
    expect(transcript).toContain("Second ask.");
    expect(transcript).toContain("Third ask.");
    expect(transcript).toContain("Short closing reply.");
    expect(transcript.length).toBeLessThan(1_300);
    // Entry numbers stay those of the full thread, so a gap shows something was left out.
    expect(transcript).toContain("[5] USER");
  });
});

describe("turnsFinishedSince", () => {
  const runs = [
    { id: "run:1", ordinal: 1, status: "completed" },
    { id: "run:2", ordinal: 2, status: "failed" },
    { id: "run:3", ordinal: 3, status: "completed" },
    { id: "run:4", ordinal: 4, status: "running" },
    { id: "run:5", ordinal: 5, status: "queued" },
  ];

  it("counts the turns that ended after the run the checklist was written from", () => {
    expect(turnsFinishedSince(runs, "run:1")).toBe(2);
    expect(turnsFinishedSince(runs, "run:3")).toBe(0);
  });

  it("counts every finished turn when there is no checklist or its run is gone", () => {
    expect(turnsFinishedSince(runs, null)).toBe(3);
    expect(turnsFinishedSince(runs, "run:deleted")).toBe(3);
  });
});

describe("a checklist written while a turn runs", () => {
  const runs = [
    { id: "run:1", ordinal: 1, status: "completed" },
    { id: "run:2", ordinal: 2, status: "interrupted" },
    { id: "run:3", ordinal: 3, status: "running" },
    { id: "run:4", ordinal: 4, status: "queued" },
  ];

  it("stands on the newest turn that has ended, which the running one then counts after", () => {
    expect(latestFinishedRunId(runs)).toBe("run:2");
    expect(latestFinishedRunId([{ id: "run:9", ordinal: 1, status: "running" }])).toBeNull();
    const ended = runs.map((run) => (run.id === "run:3" ? { ...run, status: "completed" } : run));
    expect(turnsFinishedSince(ended, latestFinishedRunId(runs))).toBe(1);
  });

  it("leaves out the messages of turns that have not ended", () => {
    const kept = messagesOfFinishedTurns(
      [
        message("user", "first ask", "run:1"),
        message("assistant", "first reply", "run:1"),
        message("user", "running ask", "run:3"),
        message("assistant", "half a repl", "run:3"),
        message("user", "queued ask", "run:4"),
        message("user", "outside any turn", null),
      ],
      runs,
    );
    expect(kept.map((entry) => entry.text)).toEqual([
      "first ask",
      "first reply",
      "outside any turn",
    ]);
  });
});

describe("checklistIsCurrent", () => {
  it("is current only when it was written from the thread's latest run", () => {
    expect(checklistIsCurrent({ basedOnRunId: "run:2" }, "run:2")).toBe(true);
    expect(checklistIsCurrent({ basedOnRunId: "run:1" }, "run:2")).toBe(false);
  });

  it("is not current without a checklist or without a run to compare", () => {
    expect(checklistIsCurrent(null, "run:2")).toBe(false);
    expect(checklistIsCurrent({ basedOnRunId: null }, null)).toBe(false);
  });
});
