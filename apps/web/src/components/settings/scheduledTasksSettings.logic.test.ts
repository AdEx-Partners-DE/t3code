import {
  EnvironmentId,
  ProjectId,
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  scheduledTaskDefaultModel,
  defaultScheduledTaskProjectId,
  defaultSortDescending,
  matchesScheduledTaskScope,
  organizeScheduledTasks,
  scheduleFromDraft,
  taskToDraft,
  type ScheduledTaskListView,
  unbindDraftFromThread,
} from "./scheduledTasksSettings.logic";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");
const environments = [
  { environmentId: laptopId, label: "Laptop" },
  { environmentId: serverId, label: "Server" },
];

function member(id: string, environmentId: EnvironmentId): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "T3 Code",
    workspaceRoot: `/repos/${id}`,
    physicalProjectKey: `${environmentId}:/repos/${id}`,
    environmentLabel:
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

const first = member("first", laptopId);
const second = member("second", laptopId);
const third = member("third", serverId);
const other = member("other", serverId);

function group(
  projectKey: string,
  members: readonly SidebarProjectGroupMember[],
): SidebarProjectSnapshot {
  return {
    ...members[0]!,
    projectKey,
    displayName: projectKey,
    memberProjects: members,
    memberProjectRefs: members.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteEnvironmentLabels: [],
    pinned: false,
    archived: false,
  };
}

const sameIdElsewhere = member("first", serverId);
const groups = [group("t3code", [first, second, third]), group("other", [other, sameIdElsewhere])];
const tasks = [first, second, third, other, sameIdElsewhere].map((project, index) => ({
  id: `task-${index}`,
  environmentId: project.environmentId,
  projectId: project.id,
}));

describe("scheduled task settings scope", () => {
  it.each<{ search: SettingsScopeSearch; expected: string[] }>([
    { search: {}, expected: ["task-0", "task-1", "task-2", "task-3", "task-4"] },
    { search: { machine: laptopId }, expected: ["task-0", "task-1"] },
    { search: { project: "t3code" }, expected: ["task-0", "task-1", "task-2"] },
    { search: { project: "t3code", machine: serverId }, expected: ["task-2"] },
    { search: { project: "t3code", checkout: second.physicalProjectKey }, expected: ["task-1"] },
    { search: { project: "missing" }, expected: [] },
    { search: { machine: "removed" }, expected: [] },
    { search: { project: "t3code", checkout: "removed" }, expected: [] },
    { search: { project: "other", machine: laptopId }, expected: [] },
  ])("lists only matching tasks for $search", ({ search, expected }) => {
    const scope = resolveSettingsScope(search, groups, environments);
    expect(
      tasks
        .filter((task) => matchesScheduledTaskScope(scope, task.environmentId, task.projectId))
        .map((task) => task.id),
    ).toEqual(expected);
  });

  it("defaults a new task to a pinned open project, and to an archived one only when scoped to it", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const project = (id: string, pinnedAt: string | null, archivedAt: string | null) => ({
      id: ProjectId.make(id),
      pinnedAt,
      archivedAt,
    });
    const all = resolveSettingsScope({}, groups, environments);
    const scoped = resolveSettingsScope({ project: "t3code" }, groups, environments);
    expect(
      defaultScheduledTaskProjectId([project("a", null, null), project("b", at, null)], all),
    ).toBe("b");
    expect(defaultScheduledTaskProjectId([project("x", null, at)], all)).toBe("");
    expect(defaultScheduledTaskProjectId([project("x", null, at)], scoped)).toBe("x");
  });

  it("keeps tasks with removed projects manageable at environment scope", () => {
    const removedProject = ProjectId.make("removed");
    expect(
      matchesScheduledTaskScope(
        resolveSettingsScope({}, groups, environments),
        laptopId,
        removedProject,
      ),
    ).toBe(true);
    expect(
      matchesScheduledTaskScope(
        resolveSettingsScope({ project: "t3code" }, groups, environments),
        laptopId,
        removedProject,
      ),
    ).toBe(false);
  });
});

const legacyTask: ScheduledTask = {
  id: ScheduledTaskId.make("legacy-task"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project"),
  threadId: null,
  workspaceStrategy: { type: "worktree", baseRef: "release" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

describe("organizing the scheduled task list", () => {
  const task = (title: string, fields: Partial<ScheduledTask>) =>
    ({
      id: ScheduledTaskId.make(title),
      title,
      enabled: true,
      runCount: 0,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      ...fields,
    }) as ScheduledTask;
  const tasks = [
    task("busy", {
      runCount: 700,
      lastRunAt: "2026-11-01T10:00:00.000Z",
      nextRunAt: "2026-11-01T11:00:00.000Z",
    }),
    task("stale", { enabled: false, runCount: 12, lastRunAt: "2026-10-01T10:00:00.000Z" }),
    task("never", { enabled: false }),
    task("old", {
      enabled: false,
      runCount: 3,
      lastRunAt: "2026-09-01T10:00:00.000Z",
      archivedAt: "2026-10-20T10:00:00.000Z" as ScheduledTask["createdAt"],
    }),
  ];
  const titles = (view: Partial<ScheduledTaskListView>) =>
    organizeScheduledTasks(tasks, {
      show: "current",
      sort: "lastRun",
      descending: true,
      ...view,
    }).map((entry) => entry.title);

  it("sorts a task that never ran as the oldest, in either direction", () => {
    expect(titles({})).toEqual(["busy", "stale", "never"]);
    expect(titles({ descending: false })).toEqual(["never", "stale", "busy"]);
  });

  it("puts a task without a next run after every timed one", () => {
    expect(titles({ sort: "nextRun", descending: false })).toEqual(["busy", "never", "stale"]);
  });

  it("sorts by run count both ways and by name", () => {
    expect(titles({ sort: "runCount" })).toEqual(["busy", "stale", "never"]);
    expect(titles({ sort: "runCount", descending: false })).toEqual(["never", "stale", "busy"]);
    expect(titles({ sort: "title", descending: false })).toEqual(["busy", "never", "stale"]);
  });

  it("keeps archived tasks out of every view but their own", () => {
    expect(titles({ show: "off" })).toEqual(["stale", "never"]);
    expect(titles({ show: "on" })).toEqual(["busy"]);
    expect(titles({ show: "archived" })).toEqual(["old"]);
  });

  it("starts counts and past runs high, names and next runs low", () => {
    expect(defaultSortDescending("runCount")).toBe(true);
    expect(defaultSortDescending("nextRun")).toBe(false);
  });
});

describe("editing scheduled task branch settings", () => {
  it("keeps an omitted origin flag on the local base branch", () => {
    const draft = taskToDraft(legacyTask);
    expect(draft.baseRef).toBe("release");
    expect(draft.startFromOrigin).toBe(false);
  });
});

describe("idle scheduled tasks", () => {
  const idleTask: ScheduledTask = {
    ...legacyTask,
    schedule: { type: "idle", maxRuns: 4, minPauseMs: 90_000, runsUsed: 3 },
    nextRunAt: null,
  };

  it("opens and saves as an idle task, without the server's run counter", () => {
    const draft = taskToDraft(idleTask);
    expect(draft.scheduleMode).toBe("idle");
    expect(scheduleFromDraft(draft)).toEqual({ type: "idle", maxRuns: 4, minPauseMs: 90_000 });
  });

  it("keeps a stop phrase through open and save, and drops an empty one", () => {
    const draft = taskToDraft({
      ...idleTask,
      schedule: { type: "idle", maxRuns: 4, minPauseMs: 90_000, stopPhrase: "ALL DONE" },
    });
    expect(draft.idleStopPhrase).toBe("ALL DONE");
    expect(scheduleFromDraft({ ...draft, idleStopPhrase: "  ALL DONE " })).toEqual({
      type: "idle",
      maxRuns: 4,
      minPauseMs: 90_000,
      stopPhrase: "ALL DONE",
    });
    expect(scheduleFromDraft({ ...draft, idleStopPhrase: "  " })).toEqual({
      type: "idle",
      maxRuns: 4,
      minPauseMs: 90_000,
    });
    expect(scheduleFromDraft({ ...draft, idleStopPhrase: "ok" })).toBeNull();
  });

  it("keeps a usage budget through open and save, and refuses one out of range", () => {
    const draft = taskToDraft({
      ...idleTask,
      schedule: { type: "idle", maxRuns: 4, minPauseMs: 90_000, minRemainingPercent: 25 },
    });
    expect(draft.idleMinRemainingPercent).toBe("25");
    expect(scheduleFromDraft(draft)).toEqual({
      type: "idle",
      maxRuns: 4,
      minPauseMs: 90_000,
      minRemainingPercent: 25,
    });
    expect(scheduleFromDraft({ ...draft, idleMinRemainingPercent: "" })).toEqual({
      type: "idle",
      maxRuns: 4,
      minPauseMs: 90_000,
    });
    expect(scheduleFromDraft({ ...draft, idleMinRemainingPercent: "100" })).toBeNull();
    expect(scheduleFromDraft({ ...draft, idleMinRemainingPercent: "2.5" })).toBeNull();
  });

  it("chains behind another thread, and treats the task's own thread as no chain", () => {
    const draft = { ...taskToDraft(idleTask), threadId: "thread:b" };
    expect(scheduleFromDraft({ ...draft, idleWatchThreadId: "thread:a" })).toEqual({
      type: "idle",
      maxRuns: 4,
      minPauseMs: 90_000,
      watchThreadId: "thread:a",
    });
    expect(scheduleFromDraft({ ...draft, idleWatchThreadId: "thread:b" })).toEqual({
      type: "idle",
      maxRuns: 4,
      minPauseMs: 90_000,
    });
  });

  it("keeps supervision and left-out threads of an all-threads task through open and save", () => {
    const draft = taskToDraft({
      ...idleTask,
      schedule: {
        type: "idle",
        maxRuns: 4,
        minPauseMs: 90_000,
        runsUsed: 3,
        allOpenThreads: true,
        maxParallel: 3,
        supervise: true,
        supervised: { "thread:a": 2 },
        excludeThreadIds: [ThreadId.make("thread:legal")],
      },
    });
    expect(draft.idleSupervise).toBe(true);
    expect(draft.idleExcludeThreadIds).toEqual(["thread:legal"]);
    // The server's own counters are not sent back.
    expect(scheduleFromDraft(draft)).toEqual({
      type: "idle",
      maxRuns: 4,
      minPauseMs: 90_000,
      allOpenThreads: true,
      maxParallel: 3,
      supervise: true,
      excludeThreadIds: ["thread:legal"],
    });
    expect(scheduleFromDraft({ ...draft, idleSupervise: false, idleExcludeThreadIds: [] })).toEqual(
      { type: "idle", maxRuns: 4, minPauseMs: 90_000, allOpenThreads: true, maxParallel: 3 },
    );
  });

  it("refuses a missing or unbounded run limit", () => {
    const draft = taskToDraft(idleTask);
    expect(scheduleFromDraft({ ...draft, idleMaxRuns: "" })).toBeNull();
    expect(scheduleFromDraft({ ...draft, idleMaxRuns: "0" })).toBeNull();
    expect(scheduleFromDraft({ ...draft, idleMaxRuns: "2.5" })).toBeNull();
    expect(scheduleFromDraft({ ...draft, idlePauseMinutes: "-1" })).toBeNull();
  });
});

describe("fixed-time scheduled tasks", () => {
  it("pads a stored single-digit hour so the time input shows it", () => {
    const draft = taskToDraft({
      ...legacyTask,
      schedule: { type: "fixed_time", timeOfDay: "9:05" },
    });
    expect(draft.timeOfDay).toBe("09:05");
  });
});

describe("scheduled task destination", () => {
  it("unbinding leaves the shared checkout for a new worktree from the remote", () => {
    const rootBound = taskToDraft({
      ...legacyTask,
      threadId: ThreadId.make("thread:bound"),
      workspaceStrategy: { type: "root" },
    });
    expect(unbindDraftFromThread(rootBound)).toMatchObject({
      threadId: "",
      workspaceMode: "worktree",
      startFromOrigin: true,
    });
  });
});

describe("one-time scheduled tasks", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips the run time through the local date-time input", () => {
    const runAt = "2026-11-03T17:00:42.000Z";
    const draft = taskToDraft({ ...legacyTask, schedule: { type: "once", runAt } });
    expect(draft.scheduleMode).toBe("once");
    expect(scheduleFromDraft(draft)).toEqual({ type: "once", runAt });
    const moved = scheduleFromDraft({ ...draft, runAt: "2026-11-04T09:30" });
    expect(moved).toEqual({ type: "once", runAt: new Date("2026-11-04T09:30").toISOString() });
    expect(scheduleFromDraft({ ...draft, runAt: "" })).toBeNull();
  });

  it("rejects a time skipped by daylight saving", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const draft = taskToDraft({
      ...legacyTask,
      schedule: { type: "once", runAt: "2027-03-14T18:00:00.000Z" },
    });
    expect(scheduleFromDraft({ ...draft, runAt: "2027-03-14T02:30" })).toBeNull();
  });

  it("keeps the saved offset when an edit stays in an hour that repeats", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    // 01:30 PST, the second 01:30 on 2026-11-01.
    const draft = taskToDraft({
      ...legacyTask,
      schedule: { type: "once", runAt: "2026-11-01T09:30:00.000Z" },
    });
    expect(scheduleFromDraft({ ...draft, runAt: "2026-11-01T01:35" })).toEqual({
      type: "once",
      runAt: "2026-11-01T09:35:00.000Z",
    });
  });
});

describe("webhook scheduled tasks", () => {
  const signature = { header: "x-signature", encoding: "base64", prefix: "" } as const;
  const webhookTask: ScheduledTask = {
    ...legacyTask,
    schedule: { type: "webhook", signature },
    webhook: { path: "/api/hooks/legacy-task/token", url: null, hasSecret: true },
  };

  it("round-trips dedupe settings, clears them, and rejects invalid windows", () => {
    const dedupe = {
      replayKey: "{{headers.delivery-id}}",
      coalesceKey: "{{body.id}}",
      coalesceWindowSeconds: 10,
    };
    const draft = taskToDraft({
      ...webhookTask,
      schedule: { type: "webhook", signature: null, dedupe },
    });
    expect(scheduleFromDraft(draft)).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: " \n ",
        coalesceKey: " \t ",
        coalesceWindowSeconds: "",
      }),
    ).toMatchObject({ dedupe: {} });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: `  ${dedupe.replayKey}  `,
        coalesceKey: `\t${dedupe.coalesceKey}\n`,
      }),
    ).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({ ...draft, replayKey: "", coalesceKey: "", coalesceWindowSeconds: "" }),
    ).toMatchObject({ dedupe: {} });
    expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds: "" })).toMatchObject({
      dedupe: { replayKey: dedupe.replayKey, coalesceKey: dedupe.coalesceKey },
    });
    for (const coalesceWindowSeconds of ["9", "3601", "1.5", "abc"]) {
      expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds })).toBeNull();
    }
  });

  it("keeps a stored secret when the secret field is left blank", () => {
    const draft = taskToDraft(webhookTask);
    expect(draft.scheduleMode).toBe("webhook");
    expect(draft.signatureSecret).toBe("");
    expect(scheduleFromDraft(draft)).toEqual({
      type: "webhook",
      signature,
      maxDeliveryAgeMinutes: null,
      dedupe: {},
    });
    expect(scheduleFromDraft({ ...draft, signatureSecret: " new " })).toEqual({
      type: "webhook",
      signature: { ...signature, secret: "new" },
      maxDeliveryAgeMinutes: null,
      dedupe: {},
    });
  });

  it("round-trips the max age, treats blank as no limit, and rejects an invalid limit", () => {
    const draft = taskToDraft({
      ...webhookTask,
      schedule: { type: "webhook", signature: null, maxDeliveryAgeMinutes: 90 },
    });
    expect(draft.maxDeliveryAgeMinutes).toBe("90");
    expect(scheduleFromDraft(draft)).toMatchObject({ maxDeliveryAgeMinutes: 90 });
    for (const blank of ["", "  "]) {
      expect(scheduleFromDraft({ ...draft, maxDeliveryAgeMinutes: blank })).toMatchObject({
        maxDeliveryAgeMinutes: null,
        dedupe: {},
      });
    }
    for (const invalid of ["0", "-5", "1.5", "abc", "1441"]) {
      expect(scheduleFromDraft({ ...draft, maxDeliveryAgeMinutes: invalid })).toBeNull();
    }
  });

  it("sends filters only when the form changed them", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.action", op: "in", value: ["opened", "reopened"] },
    ] as const;
    const draft = taskToDraft({
      ...webhookTask,
      schedule: { type: "webhook", signature, filters },
    });
    expect(draft.filters.map((filter) => filter.op)).toEqual(["equals", "in"]);
    // A title-only save leaves the key out, so the server keeps whatever is stored now.
    expect(scheduleFromDraft({ ...draft, title: "Renamed" })).not.toHaveProperty("filters");
    expect(scheduleFromDraft({ ...draft, filters: draft.filters.slice(0, 1) })).toMatchObject({
      filters: filters.slice(0, 1),
    });
    // Removing every row is a change, so it clears the stored filters.
    expect(scheduleFromDraft({ ...draft, filters: [] })).toMatchObject({ filters: [] });
    expect(
      scheduleFromDraft({
        ...draft,
        filters: [{ id: "f1", path: "body.action", op: "in", value: " , " }],
      }),
    ).toBeNull();
  });
});

describe("scheduled task model defaults", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const projectId = ProjectId.make("project");
  const environmentSelection = {
    instanceId,
    model: "environment-model",
    options: [{ id: "reasoning", value: "high" }],
  };
  const projectSelection = { instanceId, model: "project-model" };
  const config = {
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: environmentSelection },
    providers: [
      {
        instanceId,
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          { slug: "first-model", name: "First", isCustom: false, capabilities: null },
          {
            slug: "catalog-default",
            name: "Default",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
          { slug: "environment-model", name: "Environment", isCustom: false, capabilities: null },
          { slug: "project-model", name: "Project", isCustom: false, capabilities: null },
        ],
      },
    ],
  } as unknown as ServerConfig;
  const resolve = (
    value: ServerConfig,
    project: { id: typeof projectId; defaultModelSelection?: typeof projectSelection } | null,
  ) =>
    scheduledTaskDefaultModel(
      value.settings,
      project,
      deriveProviderInstanceEntries(value.providers),
    );
  it("uses the advertised default instead of catalog order when no default is configured", () => {
    expect(
      resolve({ ...config, settings: { ...config.settings, defaultModelSelection: null } }, null),
    ).toEqual({ instanceId, model: "catalog-default" });
  });
  it("falls back to the environment default when the project provider is unavailable", () => {
    expect(
      resolve(config, {
        id: projectId,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("unavailable"),
          model: "missing",
        },
      }),
    ).toEqual(environmentSelection);
  });
});

it("rejects dedupe templates without a request placeholder", () => {
  const draft = taskToDraft({ ...legacyTask, schedule: { type: "webhook", signature: null } });
  expect(scheduleFromDraft({ ...draft, replayKey: "literal" })).toBeNull();
  expect(scheduleFromDraft({ ...draft, coalesceKey: "{{body.bad" })).toBeNull();
});
