import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";

import { relatedThreadAutomations, summarizeAutomations } from "./threadAutomations.ts";

const project = ProjectId.make("project");
const threadId = ThreadId.make("thread");

const task = (id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title: id,
  prompt: "Do the work",
  enabled: true,
  schedule: { type: "interval", everyMs: 1_800_000 },
  projectId: project,
  threadId: ThreadId.make(`${id}-home`),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  ...overrides,
});

const idle = (overrides: Partial<Extract<ScheduledTask["schedule"], { type: "idle" }>> = {}) =>
  ({ type: "idle", maxRuns: 10, minPauseMs: 0, ...overrides }) as const;

type Thread = Parameters<typeof relatedThreadAutomations>[0]["thread"];

const openThread: Thread = {
  id: threadId,
  projectId: project,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
};

const reasons = (tasks: ReadonlyArray<ScheduledTask>, thread: Thread = openThread) =>
  relatedThreadAutomations({ tasks, threadId, thread }).map(
    ({ task, reason }) => `${task.id}:${reason}`,
  );

describe("relatedThreadAutomations", () => {
  it("lists a task that sends to all open threads, and leaves out the thread's own tasks", () => {
    expect(
      reasons([
        task("own", { threadId }),
        task("all", { threadId: null, schedule: idle({ allOpenThreads: true }) }),
        task("elsewhere"),
      ]),
    ).toEqual(["all:covers-open-threads"]);
  });

  it("does not claim coverage the server would not send", () => {
    const settled: Thread = { ...openThread!, settledAt: "2026-10-14T09:00:00.000Z" };
    expect(
      reasons(
        [
          task("other-project", {
            projectId: ProjectId.make("other"),
            schedule: idle({ allOpenThreads: true, projectOnly: true }),
          }),
          task("excluded", {
            schedule: idle({ allOpenThreads: true, excludeThreadIds: [threadId] }),
          }),
          task("off", { enabled: false, schedule: idle({ allOpenThreads: true }) }),
        ],
        openThread,
      ),
    ).toEqual([]);
    expect(reasons([task("all", { schedule: idle({ allOpenThreads: true }) })], settled)).toEqual(
      [],
    );
  });

  it("lists a task waiting for this thread, then tasks running elsewhere last", () => {
    expect(
      reasons([
        task("busy", { lastRunStatus: "running" }),
        task("after", { schedule: idle({ watchThreadId: threadId, maxRuns: 1 }) }),
      ]),
    ).toEqual(["after:waits-for-thread", "busy:running"]);
  });
});

describe("summarizeAutomations", () => {
  it("counts held tasks apart and names the next one that starts on its own", () => {
    const summary = summarizeAutomations({
      tasks: [
        task("soon", { nextRunAt: "2026-10-14T10:05:00.000Z" }),
        task("later", { nextRunAt: "2026-10-14T11:00:00.000Z" }),
        task("held", { nextRunAt: "2026-10-14T10:01:00.000Z" }),
        task("off", { enabled: false, nextRunAt: "2026-10-14T10:00:30.000Z" }),
      ],
      paused: true,
      exemptIds: ["soon", "later"],
    });
    expect(summary.onCount).toBe(2);
    expect(summary.heldCount).toBe(1);
    expect(summary.next?.id).toBe("soon");
  });
});
