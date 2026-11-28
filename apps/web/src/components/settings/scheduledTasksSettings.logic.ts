import * as Schema from "effect/Schema";
import { isListedThreadLineage, isWebhookDedupeTemplate } from "@t3tools/contracts";
import {
  EnvironmentId,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  type ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskSchedule,
  type ScheduledTaskThreadMode,
  type ScheduledTaskUpsertSchedule,
  scheduledTaskThreadMode,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  webhookFilterDrafts,
  webhookFilterDraftsChanged,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import { scheduleTimeZoneLabel } from "@t3tools/client-runtime/scheduled-task-time-zone";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { msg } from "gt-react";

import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import { getActiveLocale, m, type MessageResolver } from "../../i18n/messages";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { formatDateTimeTimestamp, formatTimeOfDay } from "../../timestampFormat";

import type { ResolvedSettingsScope } from "./settingsScope";

/** Abbreviated weekday name, 0 = Sunday. */
export function weekdayShortLabel(day: number, locale: string = getActiveLocale()): string {
  // 2024-01-07 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(2024, 0, 7 + day)),
  );
}

export function scheduleLabel(
  schedule: ScheduledTaskSchedule,
  timestampFormat: TimestampFormat,
  timeZone?: string,
  runAt?: string | null,
  resolve: MessageResolver = m,
  locale: string = getActiveLocale(),
): string {
  if (schedule.type === "webhook") return resolve(msg("On webhook"));
  if (schedule.type === "idle") {
    const runs = resolve(
      msg(
        "{scope, select, project {Open threads of this project, when idle} all {All open threads, when idle} other {When idle}}{supervised, select, yes {, supervised} other {}}, {used} of {max} runs used",
        {
          scope: schedule.allOpenThreads ? (schedule.projectOnly ? "project" : "all") : "single",
          supervised: schedule.supervise === true ? "yes" : "no",
          used: schedule.runsUsed ?? 0,
          max: schedule.maxRuns,
        },
      ),
    );
    return [
      runs,
      ...(schedule.stopPhrase === undefined
        ? []
        : [resolve(msg('stops at "{phrase}"', { phrase: schedule.stopPhrase }))]),
      ...(schedule.minRemainingPercent === undefined
        ? []
        : [resolve(msg("stops under {percent}% left", { percent: schedule.minRemainingPercent }))]),
      ...(schedule.watchThreadId === undefined ? [] : [resolve(msg("waits for another thread"))]),
    ].join(", ");
  }
  if (schedule.type === "once") {
    return resolve(
      msg("Once, {time}", { time: formatDateTimeTimestamp(schedule.runAt, timestampFormat) }),
    );
  }
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? resolve(msg("Every {minutes} min", { minutes }))
      : resolve(msg("Every {seconds} sec", { seconds: Math.round(schedule.everyMs / 1000) }));
  }
  const weekdays = [...new Set(schedule.weekdays ?? [])]
    .filter((day) => day >= 0 && day <= 6)
    .toSorted((a, b) => a - b);
  const time = formatTimeOfDay(schedule.timeOfDay, timestampFormat);
  const zone = scheduleTimeZoneLabel(timeZone, runAt);
  if (weekdays.length === 0 || weekdays.length === 7) {
    return zone === undefined
      ? resolve(msg("Daily at {time}", { time }))
      : resolve(msg("Daily at {time} {zone}", { time, zone }));
  }
  if (weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)) {
    return zone === undefined
      ? resolve(msg("Weekdays at {time}", { time }))
      : resolve(msg("Weekdays at {time} {zone}", { time, zone }));
  }
  const days = weekdays.map((day) => weekdayShortLabel(day, locale)).join(", ");
  return zone === undefined
    ? resolve(msg("{days} at {time}", { days, time }))
    : resolve(msg("{days} at {time} {zone}", { days, time, zone }));
}

export function matchesScheduledTaskScope(
  scope: ResolvedSettingsScope,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  if (scope.kind === "unavailable" || !scope.environmentIds.includes(environmentId)) return false;
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    );
  }
  return true;
}

export function validateScheduledTasksSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
  };
}

export const SCHEDULED_TASK_SHOWS = {
  current: msg("Not archived"),
  on: msg("On", { $context: "filter: scheduled tasks that are switched on" }),
  off: msg("Off", { $context: "filter: scheduled tasks that are switched off" }),
  archived: msg("Archived", { $context: "filter: archived scheduled tasks" }),
} as const;
export type ScheduledTaskShow = keyof typeof SCHEDULED_TASK_SHOWS;

export const SCHEDULED_TASK_SORTS = {
  lastRun: msg("Last run"),
  runCount: msg("Run count"),
  nextRun: msg("Next run"),
  title: msg("Name", { $context: "sort by task name" }),
  created: msg("Created", { $context: "sort by creation date" }),
} as const;
export type ScheduledTaskSort = keyof typeof SCHEDULED_TASK_SORTS;

export const ScheduledTaskListView = Schema.Struct({
  show: Schema.Literals(["current", "on", "off", "archived"]),
  sort: Schema.Literals(["lastRun", "runCount", "nextRun", "title", "created"]),
  descending: Schema.Boolean,
});
export type ScheduledTaskListView = typeof ScheduledTaskListView.Type;

export const DEFAULT_SCHEDULED_TASK_LIST_VIEW: ScheduledTaskListView = {
  show: "current",
  sort: "lastRun",
  descending: true,
};

/** Which way a sort first runs: names and next runs read upward, counts and past runs down. */
export function defaultSortDescending(sort: ScheduledTaskSort): boolean {
  return sort !== "title" && sort !== "nextRun";
}

export function scheduledTaskMatchesShow(
  task: Pick<ScheduledTask, "enabled" | "archivedAt">,
  show: ScheduledTaskShow,
): boolean {
  if (show === "archived") return task.archivedAt !== undefined;
  if (task.archivedAt !== undefined) return false;
  return show === "current" || task.enabled === (show === "on");
}

function timeOr(value: string | null, missing: number): number {
  return value === null ? missing : Date.parse(value);
}

function sortValue(task: ScheduledTask, sort: Exclude<ScheduledTaskSort, "title">): number {
  if (sort === "runCount") return task.runCount;
  if (sort === "created") return Date.parse(task.createdAt);
  // Never ran reads as oldest and no next run as furthest off, so both end up where
  // a cleanup looks for them instead of between real dates.
  return sort === "lastRun"
    ? timeOr(task.lastRunAt, Number.NEGATIVE_INFINITY)
    : timeOr(task.nextRunAt, Number.POSITIVE_INFINITY);
}

export function organizeScheduledTasks(
  tasks: ReadonlyArray<ScheduledTask>,
  view: ScheduledTaskListView,
): ReadonlyArray<ScheduledTask> {
  const direction = view.descending ? -1 : 1;
  const compare = (left: ScheduledTask, right: ScheduledTask) => {
    if (view.sort === "title") return direction * left.title.localeCompare(right.title);
    const [a, b] = [sortValue(left, view.sort), sortValue(right, view.sort)];
    return a === b ? left.title.localeCompare(right.title) : direction * (a < b ? -1 : 1);
  };
  return tasks.filter((task) => scheduledTaskMatchesShow(task, view.show)).toSorted(compare);
}

export type ScheduleMode = "fixed" | "once" | "interval" | "webhook" | "idle";
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";

export interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  /** Idle tasks: how many times the prompt may run before the task turns itself off. */
  readonly idleMaxRuns: string;
  /** Idle tasks: shortest wait after a run ends, in minutes as typed. */
  readonly idlePauseMinutes: string;
  /** Idle tasks: text in the thread's last reply that ends the task early. Empty for none. */
  readonly idleStopPhrase: string;
  /** Idle tasks: the other thread to wait for. Empty waits for the task's own thread. */
  readonly idleWatchThreadId: string;
  /** Send to every open thread that stands still instead of `threadId`. */
  readonly idleAllOpenThreads: boolean;
  /** With `idleAllOpenThreads`: only the threads of the task's project. */
  readonly idleProjectOnly: boolean;
  readonly idleSupervise: boolean;
  readonly idleExcludeThreadIds: ReadonlyArray<string>;
  /** With `idleAllOpenThreads`: how many threads may be at work at once. */
  readonly idleMaxParallel: string;
  /** Idle tasks: stop when the account has less than this percent left. Empty for no budget. */
  readonly idleMinRemainingPercent: string;
  readonly timeOfDay: string;
  /** Local date and time as a `datetime-local` input value, such as 2026-11-02T15:00. */
  readonly runAt: string;
  /** The stored ISO run time, sent back unchanged when the field was not edited. */
  readonly savedRunAt: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  /** The thread the form opened with, so a save can tell a cleared destination from an unbound one. */
  readonly savedThreadId: string;
  readonly threadMode: ScheduledTaskThreadMode;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the server. */
  readonly signatureSecret: string;
  readonly maxDeliveryAgeMinutes: string;
  readonly replayKey: string;
  readonly coalesceKey: string;
  readonly coalesceWindowSeconds: string;
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  /** The filter rows the form opened with. */
  readonly savedFilters: ReadonlyArray<WebhookFilterDraft>;
}

export const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

/** Formats a date as a `datetime-local` input value in the browser's time zone. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scheduleDraftErrors(draft: DraftState, resolve: MessageResolver = m) {
  const invalidRunTime = (description: string) => [
    { title: resolve(msg("Invalid run time")), description },
  ];
  if (draft.scheduleMode === "once") {
    const runAt = new Date(draft.runAt);
    if (Number.isNaN(runAt.getTime())) return invalidRunTime(resolve(msg("Pick a date and time.")));
    // A time skipped by a daylight saving change parses to a different clock time.
    if (toDateTimeLocalValue(runAt) !== draft.runAt)
      return invalidRunTime(resolve(msg("That time does not exist in your time zone.")));
    return [];
  }
  if (draft.scheduleMode === "fixed" && !draft.timeOfDay)
    return invalidRunTime(resolve(msg("Pick a time.")));
  if (draft.scheduleMode !== "webhook") return [];
  if (parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes) === undefined)
    return [
      {
        title: resolve(msg("Invalid age limit")),
        description: resolve(
          msg("Enter whole minutes from 1 to {max}, or leave it blank.", {
            max: MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
          }),
        ),
      },
    ];
  const errors: Array<{ title: string; description: string }> = [];
  for (const [description, value] of [
    [msg("Duplicate request key must contain a valid request placeholder."), draft.replayKey],
    [msg("Coalesce key must contain a valid request placeholder."), draft.coalesceKey],
  ] as const) {
    if (value.trim() && !isWebhookDedupeTemplate(value.trim()))
      errors.push({
        title: resolve(msg("Invalid webhook settings")),
        description: resolve(description),
      });
  }
  const window = draft.coalesceWindowSeconds.trim();
  if (window && (!Number.isInteger(Number(window)) || Number(window) < 10 || Number(window) > 3600))
    errors.push({
      title: resolve(msg("Invalid webhook settings")),
      description: resolve(msg("Coalesce window must be whole seconds from 10 to 3600.")),
    });
  return errors;
}

const WEBHOOK_DELIVERY_LABELS: Record<string, string> = {
  dispatch_failed: msg("Run failed"),
  duplicate: msg("Duplicate", { $context: "webhook delivery outcome" }),
  coalesced: msg("Coalesced"),
  filtered: msg("Filtered", { $context: "webhook delivery outcome" }),
  rejected_signature: msg("Bad signature"),
  disabled: msg("Task paused"),
  rate_limited: msg("Rate limited"),
  expired: msg("Too old"),
};

export function webhookDeliveryLabel(
  delivery: {
    readonly outcome: string;
    readonly pendingWindow?: boolean | undefined;
  },
  resolve: MessageResolver = m,
) {
  if (delivery.outcome === "accepted") {
    return delivery.pendingWindow
      ? resolve(msg("Opened window"))
      : resolve(msg("Ran", { $context: "webhook delivery outcome" }));
  }
  const label = WEBHOOK_DELIVERY_LABELS[delivery.outcome];
  return label ? resolve(label) : delivery.outcome.replaceAll("_", " ");
}

export function scheduleFromDraft(draft: DraftState): ScheduledTaskUpsertSchedule | null {
  if (scheduleDraftErrors(draft).length > 0) return null;
  if (draft.scheduleMode === "once") {
    const saved = draft.savedRunAt ? new Date(draft.savedRunAt) : null;
    if (saved !== null && toDateTimeLocalValue(saved) === draft.runAt)
      return { type: "once", runAt: draft.savedRunAt };
    // A `datetime-local` value has no offset. In an hour that repeats when clocks go
    // back, keep the saved time's offset; otherwise Date reads it as local time.
    const withSavedOffset =
      saved === null
        ? null
        : new Date(Date.parse(`${draft.runAt}Z`) + saved.getTimezoneOffset() * 60_000);
    return {
      type: "once",
      runAt:
        withSavedOffset !== null && toDateTimeLocalValue(withSavedOffset) === draft.runAt
          ? withSavedOffset.toISOString()
          : new Date(draft.runAt).toISOString(),
    };
  }
  if (draft.scheduleMode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    const replayKey = draft.replayKey.trim();
    const coalesceKey = draft.coalesceKey.trim();
    const coalesceWindowSeconds = draft.coalesceWindowSeconds.trim()
      ? Number(draft.coalesceWindowSeconds)
      : undefined;
    if (maxDeliveryAgeMinutes === undefined) return null;
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (!("filters" in parsedFilters)) return null;
    const secret = draft.signatureSecret.trim();
    return {
      type: "webhook",
      signature: draft.signatureEnabled
        ? {
            header: draft.signatureHeader.trim(),
            encoding: draft.signatureEncoding,
            prefix: draft.signaturePrefix,
            ...(secret ? { secret } : {}),
          }
        : null,
      maxDeliveryAgeMinutes,
      ...(replayKey || coalesceKey || coalesceWindowSeconds !== undefined
        ? {
            dedupe: {
              ...(replayKey ? { replayKey } : {}),
              ...(coalesceKey ? { coalesceKey } : {}),
              ...(coalesceWindowSeconds === undefined ? {} : { coalesceWindowSeconds }),
            },
          }
        : { dedupe: {} }),
      // Only edited filters are sent; the server keeps the stored ones otherwise.
      ...(webhookFilterDraftsChanged(draft.savedFilters, draft.filters)
        ? { filters: parsedFilters.filters }
        : {}),
    };
  }
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { type: "interval", everyMs };
  }
  if (draft.scheduleMode === "idle") {
    const maxRuns = Number(draft.idleMaxRuns);
    const pauseMinutes = Number(draft.idlePauseMinutes);
    // A run limit is what keeps an idle task from answering itself forever.
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 500) return null;
    if (!Number.isFinite(pauseMinutes) || pauseMinutes < 0) return null;
    const stopPhrase = draft.idleStopPhrase.trim();
    if (stopPhrase !== "" && (stopPhrase.length < 3 || stopPhrase.length > 80)) return null;
    const budget = draft.idleMinRemainingPercent.trim();
    const minRemainingPercent = budget === "" ? null : Number(budget);
    if (
      minRemainingPercent !== null &&
      (!Number.isInteger(minRemainingPercent) ||
        minRemainingPercent < 1 ||
        minRemainingPercent > 99)
    )
      return null;
    const base = {
      type: "idle" as const,
      maxRuns,
      minPauseMs: Math.round(pauseMinutes * 60_000),
      ...(stopPhrase === "" ? {} : { stopPhrase }),
      ...(minRemainingPercent === null ? {} : { minRemainingPercent }),
    };
    if (draft.idleAllOpenThreads) {
      const maxParallel = Number(draft.idleMaxParallel);
      if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 10) return null;
      return {
        ...base,
        allOpenThreads: true,
        maxParallel,
        ...(draft.idleProjectOnly ? { projectOnly: true } : {}),
        ...(draft.idleSupervise ? { supervise: true } : {}),
        ...(draft.idleExcludeThreadIds.length === 0
          ? {}
          : { excludeThreadIds: draft.idleExcludeThreadIds.map((id) => ThreadId.make(id)) }),
      };
    }
    return {
      ...base,
      ...(draft.idleWatchThreadId === "" || draft.idleWatchThreadId === draft.threadId
        ? {}
        : { watchThreadId: ThreadId.make(draft.idleWatchThreadId) }),
    };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay,
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const filters = webhookFilterDrafts(schedule.type === "webhook" ? schedule.filters : undefined);
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode: schedule.type === "fixed_time" ? "fixed" : schedule.type,
    idleMaxRuns: schedule.type === "idle" ? String(schedule.maxRuns) : "5",
    idlePauseMinutes: schedule.type === "idle" ? String(schedule.minPauseMs / 60_000) : "1",
    idleStopPhrase: schedule.type === "idle" ? (schedule.stopPhrase ?? "") : "",
    idleWatchThreadId: schedule.type === "idle" ? (schedule.watchThreadId ?? "") : "",
    idleAllOpenThreads: schedule.type === "idle" && schedule.allOpenThreads === true,
    idleProjectOnly: schedule.type === "idle" && schedule.projectOnly === true,
    idleSupervise: schedule.type === "idle" && schedule.supervise === true,
    idleExcludeThreadIds: schedule.type === "idle" ? (schedule.excludeThreadIds ?? []) : [],
    idleMaxParallel: schedule.type === "idle" ? String(schedule.maxParallel ?? 2) : "2",
    idleMinRemainingPercent:
      schedule.type === "idle" && schedule.minRemainingPercent !== undefined
        ? String(schedule.minRemainingPercent)
        : "",
    intervalMinutes:
      schedule.type === "interval" ? String(Math.max(1, schedule.everyMs / 60_000)) : "15",
    // A time input shows nothing for an unpadded hour such as 9:05, which agents may save.
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay.padStart(5, "0") : "09:00",
    runAt: schedule.type === "once" ? toDateTimeLocalValue(new Date(schedule.runAt)) : "",
    savedRunAt: schedule.type === "once" ? schedule.runAt : "",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    savedThreadId: task.threadId ?? "",
    threadMode: scheduledTaskThreadMode(task),
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "",
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelSelection: task.modelSelection,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    ...(schedule.type === "webhook" && schedule.signature !== null
      ? {
          signatureEnabled: true,
          signatureHeader: schedule.signature.header,
          signatureEncoding: schedule.signature.encoding,
          signaturePrefix: schedule.signature.prefix,
        }
      : { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }),
    signatureSecret: "",
    replayKey: schedule.type === "webhook" ? (schedule.dedupe?.replayKey ?? "") : "",
    coalesceKey: schedule.type === "webhook" ? (schedule.dedupe?.coalesceKey ?? "") : "",
    coalesceWindowSeconds:
      schedule.type === "webhook" && schedule.dedupe?.coalesceWindowSeconds !== undefined
        ? String(schedule.dedupe.coalesceWindowSeconds)
        : "",
    maxDeliveryAgeMinutes:
      schedule.type === "webhook" && schedule.maxDeliveryAgeMinutes != null
        ? String(schedule.maxDeliveryAgeMinutes)
        : "",
    filters,
    savedFilters: filters,
  };
}

export function moveDraftToThread(
  draft: DraftState,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): DraftState {
  return {
    ...draft,
    threadId: thread.id,
    projectId: thread.projectId,
    threadMode: draft.threadMode === "new_thread" ? "continue" : draft.threadMode,
  };
}

/** Leaves the thread but keeps the mode. Matches MCP: new threads stay out of the shared checkout. */
export function unbindDraftFromThread(draft: DraftState): DraftState {
  if (!draft.threadId) return draft;
  return {
    ...draft,
    threadId: "",
    ...(draft.workspaceMode === "root"
      ? { workspaceMode: "worktree" as const, startFromOrigin: true }
      : {}),
  };
}

export function changeDraftProject(draft: DraftState, projectId: string): DraftState {
  if (projectId === draft.projectId) return draft;
  return { ...unbindDraftFromThread(draft), projectId, baseRef: "", existingWorktreePath: "" };
}

/** Threads a task can move to. The current one is left out; the picker always shows it. */
export function scheduledTaskDestinationThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: string;
    readonly currentThreadId: ThreadId | null;
    readonly query: string;
  },
): ReadonlyArray<EnvironmentThreadShell> {
  const search = target.query.trim().toLocaleLowerCase();
  return threads
    .filter(
      (thread) =>
        thread.environmentId === target.environmentId &&
        thread.projectId === target.projectId &&
        thread.id !== target.currentThreadId &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        thread.title.toLocaleLowerCase().includes(search),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function scheduledTaskDefaultModel(
  settings: ServerSettings,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
  entries: readonly ProviderInstanceEntry[],
): ModelSelection | null {
  const available = entries.filter(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated",
  );
  const configured = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultModelSelection;
  for (const selection of [configured, settings.defaultModelSelection]) {
    if (
      selection &&
      available.some(
        (entry) =>
          entry.instanceId === selection.instanceId &&
          entry.models.find((model) => model.slug === selection.model)?.isLegacy !== true,
      )
    )
      return selection;
  }
  const models = available.flatMap((entry) =>
    entry.models
      .filter((model) => !model.isLegacy)
      .map((model) => ({ instanceId: entry.instanceId, model })),
  );
  const fallback = models.find(({ model }) => model.isDefault) ?? models[0];
  return fallback ? { instanceId: fallback.instanceId, model: fallback.model.slug } : null;
}

/**
 * A new task's project: a pinned open project, then any open one. An archived
 * project only when Settings is scoped to it, so that scope can still save.
 */
export function defaultScheduledTaskProjectId<
  TProject extends {
    readonly id: ProjectId;
    readonly pinnedAt?: string | null | undefined;
    readonly archivedAt?: string | null | undefined;
  },
>(scopedProjects: ReadonlyArray<TProject>, scope: ResolvedSettingsScope): ProjectId | "" {
  const open = scopedProjects.filter((project) => project.archivedAt == null);
  const scopedToProject = scope.kind === "project" || scope.kind === "checkout";
  return (
    (
      open.find((project) => project.pinnedAt != null) ??
      open[0] ??
      (scopedToProject ? scopedProjects[0] : undefined)
    )?.id ?? ""
  );
}
