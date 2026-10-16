import {
  EnvironmentId,
  type ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskUpsertSchedule,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { parseMaxDeliveryAge } from "@t3tools/client-runtime/scheduled-task-webhook";

import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import type { ProviderInstanceEntry } from "../../providerInstances";

import type { ResolvedSettingsScope } from "./settingsScope";

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

export type ScheduleMode = "fixed" | "interval" | "webhook" | "idle";
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
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  readonly modelKey: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /**
   * The picker only edits `instanceId:model`; keeping the source object preserves provider
   * options (reasoning, temperature, …) when the model itself is left unchanged.
   */
  readonly baseModelSelection: ModelSelection | null;
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the server. */
  readonly signatureSecret: string;
  readonly maxDeliveryAgeMinutes: string;
}

export const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

export function scheduleFromDraft(draft: DraftState): ScheduledTaskUpsertSchedule | null {
  if (draft.scheduleMode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    if (maxDeliveryAgeMinutes === undefined) return null;
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
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode:
      schedule.type === "interval"
        ? "interval"
        : schedule.type === "webhook"
          ? "webhook"
          : schedule.type === "idle"
            ? "idle"
            : "fixed",
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
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay : "09:00",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelKey: `${task.modelSelection.instanceId}:${task.modelSelection.model}`,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    baseModelSelection: task.modelSelection,
    ...(schedule.type === "webhook" && schedule.signature !== null
      ? {
          signatureEnabled: true,
          signatureHeader: schedule.signature.header,
          signatureEncoding: schedule.signature.encoding,
          signaturePrefix: schedule.signature.prefix,
        }
      : { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }),
    signatureSecret: "",
    maxDeliveryAgeMinutes:
      schedule.type === "webhook" && schedule.maxDeliveryAgeMinutes != null
        ? String(schedule.maxDeliveryAgeMinutes)
        : "",
  };
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
