import { describe, expect, it } from "@effect/vitest";
import { RunId, ScheduledTaskId } from "@t3tools/contracts";

import { startsWithoutTheUser } from "./QueuePauseHold.ts";

type Command = Parameters<typeof startsWithoutTheUser>[0];

const command = (overrides: Partial<Command> = {}): Command => ({
  createdBy: "user",
  creationSource: "web",
  dispatchMode: { type: "start_immediately" },
  ...overrides,
});

describe("startsWithoutTheUser", () => {
  it("lets through what the user types into a client", () => {
    expect(startsWithoutTheUser(command())).toBe(false);
    expect(startsWithoutTheUser(command({ creationSource: "mobile" }))).toBe(false);
    expect(startsWithoutTheUser(command({ dispatchMode: { type: "queue_after_active" } }))).toBe(
      false,
    );
  });

  it("holds what an agent, the server, a tool or a scheduled task sends", () => {
    expect(startsWithoutTheUser(command({ createdBy: "agent", creationSource: "mcp" }))).toBe(true);
    expect(startsWithoutTheUser(command({ createdBy: "agent", creationSource: "server" }))).toBe(
      true,
    );
    // Sent in the user's name, but not by their hand.
    expect(startsWithoutTheUser(command({ creationSource: "server" }))).toBe(true);
    expect(startsWithoutTheUser(command({ creationSource: "mcp" }))).toBe(true);
    expect(startsWithoutTheUser(command({ scheduledTaskId: ScheduledTaskId.make("task:1") }))).toBe(
      true,
    );
  });

  it("never holds a message aimed at a run under way", () => {
    const targetRunId = RunId.make("run:1");
    expect(
      startsWithoutTheUser(
        command({ createdBy: "agent", dispatchMode: { type: "steer_active", targetRunId } }),
      ),
    ).toBe(false);
    expect(
      startsWithoutTheUser(
        command({ createdBy: "agent", dispatchMode: { type: "restart_active", targetRunId } }),
      ),
    ).toBe(false);
  });
});
