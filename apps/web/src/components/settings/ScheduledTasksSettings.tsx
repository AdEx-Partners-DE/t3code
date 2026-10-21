import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  Clock3Icon,
  CopyIcon,
  InboxIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ScheduledTaskWebhookDeliverySummary,
  ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_WEBHOOK_PROMPT,
  emptyWebhookFilterDraft,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import { deriveCockpitAlerts, formatWait } from "@t3tools/client-runtime/state/cockpit-alerts";
import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ProviderInstanceId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { formatRelativeTime } from "../../timestampFormat";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { requestConfirmDialog } from "../../confirmDialog";
import { webhookAddress } from "@t3tools/client-runtime/webhook-address";
import { Link } from "@tanstack/react-router";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  type EnvironmentPresentation,
} from "../../state/environments";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useProjects, useThreadShell, useThreadShells } from "../../state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ConnectionStatusDot, connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { readEnvironmentScope } from "~/state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { SettingsGroup } from "./SettingsGroup";
import { settingsScopeEnvironmentLabel, settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import {
  WEBHOOK_SIGNATURE_DEFAULTS,
  webhookDraftErrors,
  webhookDeliveryLabel,
  matchesScheduledTaskScope,
  scheduleFromDraft,
  scheduledTaskDefaultModel,
  taskToDraft,
  type DraftState,
  type ScheduleMode,
  type WorkspaceMode,
} from "./scheduledTasksSettings.logic";
import { Label } from "../ui/label";
import { isTaskHeldByPause, taskRunsOnItsOwn } from "@t3tools/contracts";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "../ui/empty";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
} from "./settingsLayout";

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "Create a new worktree",
  root: "Use the project checkout",
  existing_worktree: "Use a specific checkout",
};

/** "Send to" value for an idle task that covers every open thread. */
const ALL_OPEN_THREADS = "all-open-threads";
const PROJECT_OPEN_THREADS = "project-open-threads";

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  idleMaxRuns: "5",
  idlePauseMinutes: "1",
  idleStopPhrase: "",
  idleMinRemainingPercent: "",
  idleWatchThreadId: "",
  idleAllOpenThreads: false,
  idleProjectOnly: false,
  idleSupervise: false,
  idleExcludeThreadIds: [],
  idleMaxParallel: "2",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
  workspaceMode: "worktree",
  baseRef: "main",
  startFromOrigin: true,
  existingWorktreePath: "",
  modelKey: "",
  runtimeMode: "full-access",
  interactionMode: "default",
  baseModelSelection: null,
  signatureEnabled: false,
  ...WEBHOOK_SIGNATURE_DEFAULTS,
  signatureSecret: "",
  maxDeliveryAgeMinutes: "",
  replayKey: "",
  coalesceKey: "",
  coalesceWindowSeconds: "",
  filters: [],
  savedFilters: [],
};

function WebhookFiltersField({
  filters,
  onChange,
}: {
  filters: ReadonlyArray<WebhookFilterDraft>;
  onChange: (filters: ReadonlyArray<WebhookFilterDraft>) => void;
}) {
  const update = (index: number, patch: Partial<WebhookFilterDraft>) =>
    onChange(filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Label>Filters</Label>
          <p className="text-sm text-muted-foreground">
            Run only when every filter matches. Other requests are logged as filtered. Separate “is
            one of” values with commas; a value can't contain a comma.
          </p>
        </div>
        <Button
          className="shrink-0"
          variant="outline"
          size="sm"
          disabled={filters.length >= MAX_WEBHOOK_FILTERS}
          onClick={() => onChange([...filters, emptyWebhookFilterDraft()])}
        >
          <PlusIcon />
          Add filter
        </Button>
      </div>
      {filters.map((filter, index) => (
        // Always stacked: the dialog stays narrow on wide windows, so a single line
        // would cut off typical paths and values. The grid wrappers size each control
        // without restyling it; a grid item stretches to its minmax(0, 1fr) track.
        <div key={filter.id} className="space-y-2 pt-1">
          <div className="flex items-center gap-2">
            <div className="grid min-w-0 flex-1 grid-cols-1">
              <Input
                aria-label={`Filter ${index + 1} path`}
                placeholder="body.action"
                value={filter.path}
                onChange={(event) => update(index, { path: event.target.value })}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove filter ${index + 1}`}
              onClick={() => onChange(removeWebhookFilterDraft(filters, filter.id))}
            >
              <Trash2Icon />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={filter.op}
              onValueChange={(op) => {
                const known = WEBHOOK_FILTER_OPS.find((option) => option.op === op);
                if (known) update(index, { op: known.op });
              }}
            >
              <div className="grid w-44 shrink-0 grid-cols-1">
                <SelectTrigger size="sm" aria-label={`Filter ${index + 1} test`}>
                  <SelectValue>
                    {WEBHOOK_FILTER_OPS.find((option) => option.op === filter.op)?.label}
                  </SelectValue>
                </SelectTrigger>
              </div>
              <SelectPopup>
                {WEBHOOK_FILTER_OPS.map((option) => (
                  <SelectItem key={option.op} value={option.op}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {filter.op === "exists" ? null : (
              <div className="grid min-w-0 flex-1 grid-cols-1">
                <Input
                  aria-label={`Filter ${index + 1} value`}
                  placeholder={filter.op === "in" ? "opened, reopened" : "opened"}
                  value={filter.value}
                  onChange={(event) => update(index, { value: event.target.value })}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

export function scheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "idle") {
    const runs = `${schedule.allOpenThreads ? (schedule.projectOnly ? "Open threads of this project, when idle" : "All open threads, when idle") : "When idle"}${schedule.supervise === true ? ", supervised" : ""}, ${schedule.runsUsed ?? 0} of ${schedule.maxRuns} runs used`;
    return [
      runs,
      ...(schedule.stopPhrase === undefined ? [] : [`stops at "${schedule.stopPhrase}"`]),
      ...(schedule.minRemainingPercent === undefined
        ? []
        : [`stops under ${schedule.minRemainingPercent}% left`]),
      ...(schedule.watchThreadId === undefined ? [] : ["waits for another thread"]),
    ].join(", ");
  }
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/**
 * `formatRelativeTime` only handles the past, and `nextRunAt` is a future
 * instant — render "in 5m" style labels for upcoming runs instead of a
 * misleading "just now".
 */
function relativeLabelAt(value: string | null, nowMs: number): string {
  if (!value) return "Not scheduled";
  const diffMs = new Date(value).getTime() - nowMs;
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value, nowMs);
    if (!relative) return "Not scheduled";
    return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

// The clock is the label's own minute tick: the React Compiler caches a
// `Date.now()` read in render on the timestamp alone.
export function ScheduledRelativeLabel(props: { value: string | null }) {
  const nowMinute = useNowMinute();
  return relativeLabelAt(props.value, Date.parse(`${nowMinute}:00.000Z`));
}

/**
 * The same label as a plain string, for text built outside JSX. It reads the
 * clock once, so a label shown for a while should use ScheduledRelativeLabel.
 */
export function relativeLabel(value: string | null): string {
  return relativeLabelAt(value, Date.now());
}

/**
 * Where a task posts, how often it has run and who made it: what tells an
 * automation an agent set up apart from one the user did.
 */
export function taskFactsLabel(task: ScheduledTask, threadTitle: string | null): string {
  const target =
    task.schedule.type === "idle" && task.schedule.allOpenThreads
      ? `At most ${task.schedule.maxParallel ?? 2} at work at once`
      : task.threadId === null
        ? "New thread each run"
        : threadTitle === null
          ? "Thread no longer exists"
          : `In "${threadTitle}"`;
  const runs = `${task.runCount} ${task.runCount === 1 ? "run" : "runs"}`;
  const last = task.lastRunAt === null ? "never ran" : `last ${relativeLabel(task.lastRunAt)}`;
  const author = task.createdBy === "agent" ? "made by an agent" : `made by ${task.createdBy}`;
  return [target, runs, last, author].join(" · ");
}

function deliveryOutcomeVariant(outcome: string) {
  if (outcome === "accepted") return "success";
  if (
    outcome === "duplicate" ||
    outcome === "coalesced" ||
    outcome === "disabled" ||
    outcome === "rate_limited" ||
    outcome === "expired"
  ) {
    return "warning";
  }
  if (outcome === "dispatch_failed" || outcome === "rejected_signature") return "error";
  return "outline";
}

function statusVariant(status: ScheduledTask["lastRunStatus"]) {
  if (status === "failed") return "error";
  if (status === "succeeded") return "success";
  if (status === "running") return "info";
  return "outline";
}

export function ScheduledTasksSettings(target: {
  readonly environmentId?: EnvironmentId;
  readonly taskId?: ScheduledTaskId | undefined;
}) {
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    task: ScheduledTask | null;
  } | null>(null);
  const openForEdit = useCallback((environmentId: EnvironmentId, task: ScheduledTask) => {
    setEditor({ environmentId, task });
  }, []);
  const defaultEnvironment = environment ?? connectedEnvironments[0];
  const canCreate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(defaultEnvironment?.environmentId ?? null),
  );
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Scheduled tasks"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!defaultEnvironment || !canCreate}
            onClick={() =>
              defaultEnvironment &&
              setEditor({ environmentId: defaultEnvironment.environmentId, task: null })
            }
          >
            <PlusIcon className="size-3" />
            New task
          </Button>
        }
      >
        {scope.kind === "unavailable" ? (
          <SettingsSection title="Unavailable selection">
            <SettingsRow title={scope.message} />
          </SettingsSection>
        ) : environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3Icon />
              </EmptyMedia>
              <EmptyTitle>No environments available</EmptyTitle>
              <EmptyDescription>Connect an environment to manage scheduled tasks.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : environments.length > 1 ? (
          <ScheduledTaskEnvironmentList
            key={`${target.environmentId ?? defaultEnvironment?.environmentId}:${target.taskId ?? ""}`}
            environmentId={target.environmentId ?? defaultEnvironment?.environmentId}
            taskId={target.taskId}
            onEdit={openForEdit}
          />
        ) : (
          <div className="space-y-8">
            {environments.map((entry) => (
              <ScheduledTaskEnvironmentSection
                key={`${entry.environmentId}:${target.taskId ?? ""}`}
                environment={entry}
                showEnvironmentHeading={environments.length > 1}
                taskId={
                  (target.environmentId ?? defaultEnvironment?.environmentId) ===
                  entry.environmentId
                    ? target.taskId
                    : undefined
                }
                onEdit={openForEdit}
              />
            ))}
          </div>
        )}
      </SettingsSection>
      {editor ? (
        <ScheduledTaskEditorDialog
          key={`${editor.environmentId}:${editor.task?.id ?? "new"}`}
          initialEnvironmentId={editor.environmentId}
          task={editor.task}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function ScheduledTaskEnvironmentList({
  environmentId,
  taskId,
  onEdit,
}: {
  readonly environmentId: EnvironmentId | undefined;
  readonly taskId: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const { scope, environments } = useSettingsScope();
  const states = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          environments.map((environment) => {
            const connected =
              environment.connection.phase === "connected" && environment.serverConfig !== null;
            const query = connected
              ? get(
                  serverEnvironment.scheduledTasksLive({
                    environmentId: environment.environmentId,
                    input: {},
                  }),
                )
              : null;
            const data = query === null ? null : Option.getOrNull(AsyncResult.value(query));
            return {
              environment,
              connected,
              tasks: data?.tasks.filter((task) =>
                matchesScheduledTaskScope(scope, environment.environmentId, task.projectId),
              ),
              error: query?._tag === "Failure" ? formatEnvironmentQueryError(query.cause) : null,
            };
          }),
        ),
      [environments, scope],
    ),
  );
  const linkedState = states.find((state) => state.environment.environmentId === environmentId);
  const linkedTask = linkedState?.tasks?.find((task) => task.id === taskId);
  const openedLink = useRef(false);
  useEffect(() => {
    if (!openedLink.current && environmentId && linkedTask) {
      openedLink.current = true;
      onEdit(environmentId, linkedTask);
    }
  }, [environmentId, linkedTask, onEdit]);

  const loaded = states.filter((state) => state.connected && state.error === null && state.tasks);
  const populated = loaded.filter((state) => state.tasks && state.tasks.length > 0);
  const summaries: Record<string, string[]> = {
    "Not connected:": [],
    "Loading scheduled tasks on": [],
    "Could not load scheduled tasks:": [],
    "No tasks on": [],
  };
  for (const { environment, connected, tasks, error } of states) {
    const label = settingsScopeEnvironmentLabel(environment, environments);
    if (!connected) {
      summaries["Not connected:"]!.push(
        `${label} (${connectionStatusTitle(environment.connection)})`,
      );
    } else if (error !== null) {
      summaries["Could not load scheduled tasks:"]!.push(`${label}: ${error}`);
    } else if (!tasks) {
      summaries["Loading scheduled tasks on"]!.push(label);
    } else if (tasks.length === 0 && populated.length > 0) {
      summaries["No tasks on"]!.push(label);
    }
  }

  return (
    <SettingsGroup>
      {populated.map(({ environment, tasks }) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        const transport = environmentTransportLabel(environment);
        return (
          <div key={environment.environmentId} className="divide-y divide-border/50">
            <EnvironmentRow
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              label={primary}
              subtitle={
                <>
                  {secondary && secondary !== transport ? (
                    <span className="block truncate">{secondary}</span>
                  ) : null}
                  <span className="block truncate">{transport}</span>
                </>
              }
            >
              <ConnectionStatusDot
                dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                tooltipText={connectionStatusTitle(environment.connection)}
              />
              <span className="text-xs text-muted-foreground">
                {connectionStatusTitle(environment.connection)}
              </span>
            </EnvironmentRow>
            {tasks?.map((task) => (
              <ScheduledTaskRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                onEdit={() => onEdit(environment.environmentId, task)}
              />
            ))}
          </div>
        );
      })}
      {taskId && linkedState?.tasks && linkedState.error === null && !linkedTask ? (
        <SettingsRow
          title="Task unavailable"
          description="This task no longer exists or is outside the selected project scope."
          role="status"
        />
      ) : null}
      {populated.length === 0 && loaded.length > 0 ? (
        <SettingsRow
          title="No scheduled tasks"
          description="No tasks match this environment and project selection."
        />
      ) : null}
      {Object.entries(summaries).map(([label, entries]) => {
        if (entries.length === 0) return null;
        const summary = `${label} ${entries.join(", ")}`;
        return (
          <Tooltip key={label}>
            <TooltipTrigger
              render={
                <p
                  className="truncate px-3 py-2.5 text-xs text-muted-foreground sm:px-4"
                  role="status"
                />
              }
            >
              {summary}
            </TooltipTrigger>
            <TooltipPopup>{summary}</TooltipPopup>
          </Tooltip>
        );
      })}
    </SettingsGroup>
  );
}

/**
 * While an update waits to go in, the server starts no task, but every switch still reads on
 * and a due task looks overdue for no reason. Same source and words as the sidebar cockpit.
 */
function ScheduledTasksUpdateHoldRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  // Counted from the start of the minute, the wait reads up to a minute long: still "at the latest".
  const nowMinute = useNowMinute();
  const result = useAtomValue(serverEnvironment.threadChecklists({ environmentId, input: {} }));
  const { updateHoldMs } = deriveCockpitAlerts(
    Option.getOrNull(AsyncResult.value(result)),
    Date.parse(`${nowMinute}:00.000Z`),
  );
  if (updateHoldMs === null) return null;
  return (
    <SettingsRow
      data-testid="scheduled-tasks-update-hold"
      role="status"
      title="Tasks wait for an update"
      description={`An update is waiting to go in: tasks start again in ${formatWait(updateHoldMs)} at the latest. Tasks that fall due meanwhile run then.`}
    />
  );
}

function ScheduledTaskEnvironmentSection({
  environment,
  showEnvironmentHeading,
  taskId,
  onEdit,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentHeading: boolean;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const { scope } = useSettingsScope();
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const tasks = tasksQuery.data?.tasks.filter((task) =>
    matchesScheduledTaskScope(scope, environment.environmentId, task.projectId),
  );
  const paused = useEnvironmentSettings(
    environment.environmentId,
    (settings) => settings.scheduledTasksPaused,
  );
  const updateEnvironmentSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const enabledCount = tasks?.filter((task) => task.enabled).length ?? 0;
  const pauseExemptIds = useEnvironmentSettings(
    environment.environmentId,
    (settings) => settings.scheduledTasksPauseExemptIds,
  );
  const heldCount =
    tasks?.filter((task) => task.enabled && isTaskHeldByPause(task.id, paused, pauseExemptIds))
      .length ?? 0;
  const linkedTask = tasks?.find((task) => task.id === taskId);
  const openedLink = useRef(false);
  useEffect(() => {
    if (!openedLink.current && linkedTask) {
      openedLink.current = true;
      onEdit(environment.environmentId, linkedTask);
    }
  }, [environment.environmentId, linkedTask, onEdit]);
  return (
    <SettingsSection
      title={environment.label}
      hideTitle={!showEnvironmentHeading}
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {!connected ? (
        <SettingsRow
          title="Environment disconnected"
          description={`Reconnect ${environment.label} to view its scheduled tasks.`}
        />
      ) : tasksQuery.error ? (
        <SettingsRow title="Could not load scheduled tasks" description={tasksQuery.error} />
      ) : !tasks ? (
        <SettingsRow title="Loading scheduled tasks…" role="status" />
      ) : (
        <>
          {taskId && !linkedTask ? (
            <SettingsRow
              title="Task unavailable"
              description="This task no longer exists or is outside the selected project scope."
              role="status"
            />
          ) : null}
          <SettingsRow
            title={paused ? "Tasks are paused" : "Pause all tasks"}
            description={
              paused
                ? heldCount === 0
                  ? "No task is held right now. New tasks stay off until you switch them on."
                  : `${heldCount} ${heldCount === 1 ? "task is" : "tasks are"} paused and read off below. Switch a single task on to resume just that one, or resume all of them here.`
                : `Switches every task in this environment off at once. Afterwards switch single tasks on again, or resume all. ${enabledCount} of ${tasks.length} enabled.`
            }
            control={
              <Button
                size="xs"
                variant="outline"
                onClick={() => updateEnvironmentSettings({ scheduledTasksPaused: !paused })}
              >
                {paused ? "Resume all tasks" : "Pause all tasks"}
              </Button>
            }
          />
          <ScheduledTasksUpdateHoldRow environmentId={environment.environmentId} />
          {tasks.length === 0 ? (
            <SettingsRow
              title="No scheduled tasks"
              description="No tasks match this environment and project selection."
            />
          ) : (
            tasks.map((task) => (
              <ScheduledTaskRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                onEdit={() => onEdit(environment.environmentId, task)}
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

function ScheduledTaskRow({
  environmentId,
  task,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onEdit: () => void;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const isWebhook = task.schedule.type === "webhook";
  // "Pause all tasks" holds the task unless it was switched on again by itself.
  const allTasksPaused = useEnvironmentSettings(
    environmentId,
    (settings) => settings.scheduledTasksPaused,
  );
  const pauseExemptIds = useEnvironmentSettings(
    environmentId,
    (settings) => settings.scheduledTasksPauseExemptIds,
  );
  const runsOnItsOwn = taskRunsOnItsOwn(task, allTasksPaused, pauseExemptIds);
  const heldByPause = task.enabled && !runsOnItsOwn;
  const boundThread = useThreadShell(
    task.threadId === null ? null : scopeThreadRef(environmentId, task.threadId),
  );
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const act = async (action: "toggle" | "run" | "delete") => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    // A deleted task cannot be restored: ask first, as mobile does.
    if (
      action === "delete" &&
      !(
        (await requestConfirmDialog(`Delete "${task.title}"?\nIts schedule and prompt are gone.`, {
          variant: "destructive",
        })) ?? window.confirm(`Delete "${task.title}"? Its schedule and prompt are gone.`)
      )
    ) {
      return;
    }
    setBusy(true);
    const result =
      action === "toggle"
        ? await toggle({ environmentId, input: { id: task.id, enabled: !runsOnItsOwn } })
        : action === "run"
          ? await run({ environmentId, input: { id: task.id } })
          : await remove({ environmentId, input: { id: task.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update scheduled task",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <SettingsRow
      title={task.title}
      description={<span className="line-clamp-2">{task.prompt}</span>}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {scheduleLabel(task.schedule)} ·{" "}
            {!task.enabled ? (
              "Off"
            ) : heldByPause ? (
              "Paused with all tasks; switch it on to resume just this one"
            ) : isWebhook ? (
              "Listening"
            ) : task.schedule.type === "idle" ? (
              // An idle task has no time; it starts when a run finishes.
              task.schedule.allOpenThreads ? (
                "Watching open threads"
              ) : (
                "Starts after the next finished run"
              )
            ) : task.nextRunAt ? (
              <>
                Next run <ScheduledRelativeLabel value={task.nextRunAt} />
              </>
            ) : (
              "Not scheduled"
            )}
          </span>
          {task.lastRunStatus !== "never" ? (
            <Badge variant={statusVariant(task.lastRunStatus)}>{task.lastRunStatus}</Badge>
          ) : null}
          {task.lastRunError ? <span className="text-destructive">{task.lastRunError}</span> : null}
          <span className="basis-full">{taskFactsLabel(task, boundThread?.title ?? null)}</span>
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            // Shows what the scheduler does: a task held by "Pause all tasks"
            // reads off, and switching it on resumes that one task.
            checked={runsOnItsOwn}
            disabled={busy || !canOperate}
            aria-label={`Enable ${task.title}`}
            onCheckedChange={() => void act("toggle")}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || !canOperate}
                  aria-label={`Actions for ${task.title}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              {isWebhook ? (
                <MenuItem onClick={() => setDeliveriesOpen(true)}>
                  <InboxIcon />
                  Deliveries
                </MenuItem>
              ) : (
                <MenuItem onClick={() => void act("run")}>
                  <PlayIcon />
                  Run now
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem onClick={() => void act("delete")}>
                <Trash2Icon />
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
          {deliveriesOpen ? (
            <WebhookDeliveriesDialog
              environmentId={environmentId}
              task={task}
              onClose={() => setDeliveriesOpen(false)}
            />
          ) : null}
        </div>
      }
    />
  );
}

function WebhookDeliveriesDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onClose: () => void;
}) {
  const deliveriesQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTaskWebhookDeliveries({
      environmentId,
      input: { id: task.id, acceptAnyOutcome: true },
    }),
  );
  const [selectedId, setSelectedId] = useState<ScheduledTaskWebhookDeliverySummary["id"] | null>(
    null,
  );
  const selectedQuery = useEnvironmentQuery(
    selectedId === null
      ? null
      : serverEnvironment.scheduledTaskWebhookDelivery({
          environmentId,
          input: { id: task.id, deliveryId: selectedId, acceptAnyOutcome: true },
        }),
  );
  const deliveries = deliveriesQuery.data?.deliveries ?? null;
  const selected = selectedQuery.data?.delivery ?? null;
  const error = selectedId === null ? deliveriesQuery.error : selectedQuery.error;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deliveries · {task.title}</DialogTitle>
          <DialogDescription>Recent requests to this task's webhook URL.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {selectedId !== null && selected === null && selectedQuery.error === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading delivery…
            </p>
          ) : selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge
                  variant={deliveryOutcomeVariant(
                    selected.pendingWindow ? "coalesced" : selected.outcome,
                  )}
                >
                  {webhookDeliveryLabel(selected)}
                </Badge>
                <span>
                  {selected.method} · <ScheduledRelativeLabel value={selected.receivedAt} />
                </span>
                {selected.signatureVerified ? (
                  <span className="text-muted-foreground">Signature verified</span>
                ) : null}
              </div>
              {selected.error ? (
                <p
                  className={
                    selected.outcome === "filtered"
                      ? "text-sm text-muted-foreground"
                      : "text-sm text-destructive"
                  }
                >
                  {selected.error}
                </p>
              ) : null}
              <DeliveryBlock
                title={selected.pendingWindow ? "Scheduled run" : "Prompt sent to the agent"}
              >
                {selected.renderedPrompt ??
                  (selected.pendingWindow
                    ? "Run scheduled when the window closes; no run started yet."
                    : "No run was started for this request.")}
              </DeliveryBlock>
              {selected.missingFields.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Empty placeholders: {selected.missingFields.join(", ")}
                </p>
              ) : null}
              <DeliveryBlock title="Headers">
                {Object.entries(selected.headers)
                  .map(([name, value]) => `${name}: ${value}`)
                  .join("\n")}
              </DeliveryBlock>
              {selected.query ? (
                <DeliveryBlock title="Query">{selected.query}</DeliveryBlock>
              ) : null}
              <DeliveryBlock title={selected.bodyTruncated ? "Body (truncated)" : "Body"}>
                {selected.body || "(empty)"}
              </DeliveryBlock>
            </div>
          ) : selectedId !== null ? null : deliveries === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading deliveries…
            </p>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-sm hover:bg-accent/40"
                    onClick={() => setSelectedId(delivery.id)}
                  >
                    <Badge
                      variant={deliveryOutcomeVariant(
                        delivery.pendingWindow ? "coalesced" : delivery.outcome,
                      )}
                    >
                      {webhookDeliveryLabel(delivery)}
                    </Badge>
                    <span>{delivery.method}</span>
                    <span className="text-muted-foreground">
                      <ScheduledRelativeLabel value={delivery.receivedAt} />
                    </span>
                    {delivery.outcome === "filtered" && delivery.error ? (
                      <span className="text-muted-foreground">{delivery.error}</span>
                    ) : null}
                    {delivery.missingFields.length > 0 ? (
                      <span className="text-muted-foreground">
                        {delivery.missingFields.length} empty placeholder
                        {delivery.missingFields.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          {selectedId !== null ? (
            <Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>
              Back
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={deliveriesQuery.isPending}
              onClick={deliveriesQuery.refresh}
            >
              Refresh
            </Button>
          )}
          <DialogClose render={<Button size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeliveryBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{title}</Label>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">
        {children}
      </pre>
    </div>
  );
}

function WebhookEndpointField({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
}) {
  const canRotate = useAtomValue(
    serverEnvironment.rotateScheduledTaskWebhookToken.permissionAtom(environmentId),
  );
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "webhook URL" });
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
  });
  const [rotating, setRotating] = useState(false);
  const endpoint = task?.webhook;
  if (!task || !endpoint) {
    return <p className="text-sm text-muted-foreground">The URL appears after you save.</p>;
  }
  const { address: url, copyable, note } = webhookAddress(endpoint, httpBaseUrl);
  const rotateUrl = async () => {
    const confirmed =
      (await requestConfirmDialog("Rotate this webhook URL?\nThe current URL stops working.", {
        variant: "destructive",
      })) ?? window.confirm("Rotate this webhook URL? The current URL stops working.");
    if (!confirmed) return;
    setRotating(true);
    const result = await rotate({ environmentId, input: { id: task.id } });
    setRotating(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not rotate webhook URL",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          readOnly
          aria-label="Webhook URL"
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={!copyable}
          onClick={() => copyToClipboard(url, undefined)}
        >
          <CopyIcon />
          {isCopied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={rotating || !canRotate}
          onClick={() => void rotateUrl()}
        >
          Rotate
        </Button>
      </div>
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {endpoint.url !== null ? <WebhookDeliveryMode environmentId={environmentId} /> : null}
    </div>
  );
}

function WebhookDeliveryMode({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const cloudLink = usePrimaryCloudLinkState();
  if (cloudLink.target?.environmentId !== environmentId || cloudLink.data === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {cloudLink.data.holdWebhooksWhileOffline
        ? "Held for up to 24 hours while this environment is offline. "
        : "Forwarded live. Requests fail while this environment is offline. "}
      <Link to="/settings/connections" className="underline underline-offset-2">
        Change in Connections
      </Link>
    </p>
  );
}

function ScheduledTaskEditorDialog({
  initialEnvironmentId,
  task,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly onClose: () => void;
}) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          project.environmentId === environmentId &&
          matchesScheduledTaskScope(scope, environmentId, project.id),
      ),
    [allProjects, environmentId, scope],
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const allThreadShells = useThreadShells();
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const [draft, setDraft] = useState<DraftState>(() =>
    task ? taskToDraft(task) : { ...EMPTY_DRAFT, projectId: projects[0]?.id ?? "" },
  );
  const [saving, setSaving] = useState(false);
  const submissionPending = useRef(false);
  const editingTaskMissing =
    draft.editingId !== null &&
    tasksQuery.data !== null &&
    !tasksQuery.data.tasks.some((entry) => entry.id === draft.editingId);
  const liveTask = tasksQuery.data
    ? (tasksQuery.data.tasks.find((entry) => entry.id === draft.editingId) ?? null)
    : task;
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  // Threads an all-threads task can leave out: the open threads it would
  // otherwise cover, plus any it already leaves out.
  const excludableThreads = useMemo(
    () =>
      draft.scheduleMode !== "idle" || !draft.idleAllOpenThreads
        ? []
        : allThreadShells
            .filter(
              (thread) =>
                thread.environmentId === environmentId &&
                (draft.idleExcludeThreadIds.includes(thread.id) ||
                  (thread.archivedAt === null &&
                    // Open as the server counts it: not settled, or taken up again.
                    thread.lineage.relationshipToParent !== "subagent" &&
                    thread.settledOverride !== "settled" &&
                    (thread.settledAt === null || thread.settledOverride === "active") &&
                    (!draft.idleProjectOnly || thread.projectId === selectedProjectId))),
            )
            .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [
      allThreadShells,
      draft.idleAllOpenThreads,
      draft.idleExcludeThreadIds,
      draft.idleProjectOnly,
      draft.scheduleMode,
      environmentId,
      selectedProjectId,
    ],
  );
  // Threads an idle task can post to or wait for: this environment's open
  // threads of the chosen project, most recently active first.
  const idleThreads = useMemo(
    () =>
      draft.scheduleMode !== "idle"
        ? []
        : allThreadShells
            .filter(
              (thread) =>
                thread.environmentId === environmentId &&
                thread.archivedAt === null &&
                (thread.projectId === selectedProjectId ||
                  thread.id === draft.threadId ||
                  thread.id === draft.idleWatchThreadId),
            )
            .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, 100),
    [
      allThreadShells,
      draft.idleWatchThreadId,
      draft.scheduleMode,
      draft.threadId,
      environmentId,
      selectedProjectId,
    ],
  );
  // The task runs in selectedProject, so its model picker should reflect that
  // project's effective enablement, not just the machine's.
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(providers),
          settings,
          selectedProject?.id ?? null,
        ),
      ),
    [providers, settings, selectedProject?.id],
  );

  const firstInstance = instanceEntries[0];
  const draftSelection = draft.modelKey ? splitModelKey(draft.modelKey) : null;
  const activeSelection =
    draftSelection &&
    instanceEntries.some((entry) => entry.instanceId === draftSelection.instanceId && entry.enabled)
      ? draftSelection
      : scheduledTaskDefaultModel(settings, selectedProject ?? null, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const submit = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      editingTaskMissing ||
      !connected ||
      tasksQuery.data === null
    )
      return;
    const selection = activeSelection;
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !projects.some((project) => project.id === selectedProjectId) ||
      selection === null
    ) {
      reportFailure("Scheduled task is incomplete", "Add a title, prompt, project, and model.");
      return;
    }
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (draft.scheduleMode === "webhook" && "error" in parsedFilters) {
      reportFailure("Invalid filter", parsedFilters.error);
      return;
    }
    const schedule = scheduleFromDraft(draft);
    if (schedule === null) {
      if (draft.scheduleMode === "idle") {
        reportFailure(
          "Invalid run limit",
          "Enter a whole number of runs from 1 to 500, a wait of 0 minutes or more and, for all open threads, 1 to 10 threads at work.",
        );
      } else {
        for (const error of webhookDraftErrors(draft))
          reportFailure(error.title, error.description);
      }
      return;
    }
    if (schedule.type === "idle" && !schedule.allOpenThreads && !draft.threadId) {
      reportFailure("Choose a thread", "A task that runs when a thread is idle needs a thread.");
      return;
    }
    if (
      schedule.type === "webhook" &&
      schedule.signature &&
      (!schedule.signature.header ||
        (!schedule.signature.secret &&
          !(liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret)))
    ) {
      reportFailure("Signing secret is required", "Enter the signature header and secret.");
      return;
    }
    if (
      schedule.type === "interval" &&
      (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
    ) {
      reportFailure("Invalid interval", "Enter an interval of at least one minute.");
      return;
    }
    if (draft.workspaceMode === "existing_worktree" && !draft.existingWorktreePath.trim()) {
      reportFailure("Checkout path is required", "Enter the path of the checkout to run in.");
      return;
    }
    const modelSelection =
      draft.baseModelSelection !== null &&
      draft.baseModelSelection.instanceId === selection.instanceId &&
      draft.baseModelSelection.model === selection.model
        ? draft.baseModelSelection
        : selection;
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : {
              type: "worktree",
              baseRef: draft.baseRef.trim() || "main",
              startFromOrigin: draft.startFromOrigin,
            };
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId, requireExisting: true } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule,
      projectId: selectedProjectId as ProjectId,
      threadId:
        draft.threadId && !(schedule.type === "idle" && schedule.allOpenThreads)
          ? (draft.threadId as ThreadId)
          : null,
      workspaceStrategy,
      modelSelection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: "web",
    };
    // Lock before React renders, and keep successful creates locked until the form closes.
    submissionPending.current = true;
    setSaving(true);
    const result = await upsertTask({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save scheduled task", squashAtomCommandFailure(result));
      }
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{draft.editingId ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            Run a prompt automatically — on an interval, at a fixed time, or when a webhook is
            called.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {/* Fieldsets default to min-width: min-content, which lets one wide control widen the form past the dialog. */}
          <fieldset disabled={saving} className="min-w-0 space-y-5">
            {!connected ? (
              <p className="text-sm text-destructive">Reconnect this environment before saving.</p>
            ) : null}
            <Field label="Runs on" htmlFor="scheduled-task-environment">
              <Select
                value={environmentId}
                disabled={task !== null || saving}
                onValueChange={(id) => {
                  const next = connectedEnvironments.find((entry) => entry.environmentId === id);
                  if (!next) return;
                  setEnvironmentId(next.environmentId);
                  setDraft((current) => ({
                    ...current,
                    projectId: "",
                    modelKey: "",
                    baseModelSelection: null,
                    baseRef: "main",
                    startFromOrigin: true,
                    existingWorktreePath: "",
                  }));
                }}
              >
                <SelectTrigger id="scheduled-task-environment" size="sm">
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <EnvironmentMachineIcon
                        kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                        className="size-4"
                      />
                      {environment?.label ?? "Unavailable environment"}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {connectedEnvironments.map((entry) => {
                    const { secondary } = settingsScopeEnvironmentLabels(
                      entry,
                      connectedEnvironments,
                    );
                    return (
                      <SelectItem
                        key={entry.environmentId}
                        value={entry.environmentId}
                        label={entry.label}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <EnvironmentMachineIcon
                            kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                            className="size-4"
                          />
                          <span className="min-w-0">
                            <span className="block truncate">{entry.label}</span>
                            {secondary ? (
                              <span className="block max-w-72 truncate text-xs text-muted-foreground">
                                {secondary}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            </Field>
            {tasksQuery.error ? (
              <p className="text-sm text-destructive" role="status">
                {tasksQuery.error}
              </p>
            ) : null}
            {editingTaskMissing ? (
              <p className="text-xs text-destructive" role="status">
                This scheduled task no longer exists.
              </p>
            ) : null}
            <Field label="Name" htmlFor="scheduled-task-title">
              <Input
                id="scheduled-task-title"
                placeholder="e.g. Check for Sentry issues"
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project" htmlFor="scheduled-task-project">
                <Select
                  value={selectedProjectId}
                  onValueChange={(projectId) =>
                    setDraft((current) => ({ ...current, projectId: projectId ?? "" }))
                  }
                >
                  <SelectTrigger size="sm" id="scheduled-task-project">
                    <SelectValue placeholder="Select a project">
                      {selectedProject?.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id} label={project.title}>
                        <span className="block truncate">{project.title}</span>
                        {allProjects.some(
                          (other) =>
                            other.title === project.title &&
                            (other.environmentId !== project.environmentId ||
                              other.id !== project.id),
                        ) ? (
                          <span className="block max-w-72 truncate text-xs text-muted-foreground">
                            {project.workspaceRoot}
                          </span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>

              {draft.scheduleMode === "idle" ? null : (
                <Field label="Workspace" htmlFor="scheduled-task-workspace">
                  <Select
                    value={draft.workspaceMode}
                    onValueChange={(value) =>
                      setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                    }
                  >
                    <SelectTrigger size="sm" id="scheduled-task-workspace">
                      <SelectValue>{WORKSPACE_MODE_LABELS[draft.workspaceMode]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="worktree">Create a new worktree</SelectItem>
                      <SelectItem value="root">Use the project checkout</SelectItem>
                      <SelectItem value="existing_worktree">Use a specific checkout</SelectItem>
                    </SelectPopup>
                  </Select>
                </Field>
              )}
            </div>

            {draft.scheduleMode !== "idle" && draft.workspaceMode === "worktree" ? (
              <Field label="Base branch" htmlFor="scheduled-task-base-ref">
                <WorktreeBaseBranchPicker
                  key={`${environmentId}:${selectedProjectId}`}
                  id="scheduled-task-base-ref"
                  environmentId={environmentId}
                  cwd={selectedProject?.workspaceRoot ?? null}
                  value={draft.baseRef}
                  onValueChange={(baseRef) => setDraft((current) => ({ ...current, baseRef }))}
                  startFromOrigin={draft.startFromOrigin}
                  onStartFromOriginChange={(startFromOrigin) =>
                    setDraft((current) => ({ ...current, startFromOrigin }))
                  }
                  disabled={saving || !connected}
                />
              </Field>
            ) : null}
            {draft.scheduleMode !== "idle" && draft.workspaceMode === "existing_worktree" ? (
              <Field label="Checkout path" htmlFor="scheduled-task-checkout">
                <Input
                  id="scheduled-task-checkout"
                  value={draft.existingWorktreePath}
                  placeholder="/path/to/checkout"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      existingWorktreePath: event.target.value,
                    }))
                  }
                />
              </Field>
            ) : null}

            <Field label="Prompt" htmlFor="scheduled-task-prompt">
              <Textarea
                id="scheduled-task-prompt"
                className="max-h-64 overflow-y-auto"
                placeholder="What should the agent do each time this runs?"
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
              />
            </Field>

            {draft.scheduleMode === "idle" ? (
              <p className="text-sm text-muted-foreground">
                Runs in the chosen thread, on the model and in the workspace that thread uses.
              </p>
            ) : (
              <Field label="Model">
                <div>
                  <ProviderModelPicker
                    environmentId={environmentId}
                    disabled={saving || !connected}
                    activeInstanceId={activeInstanceId}
                    model={activeModel}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    isComposerOwned={false}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onInstanceModelChange={(instanceId, model) =>
                      setDraft((current) => ({ ...current, modelKey: `${instanceId}:${model}` }))
                    }
                  />
                </div>
              </Field>
            )}

            <div className="space-y-3">
              {task?.schedule.type === "interval" &&
              task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS ? (
                <p className="text-sm text-muted-foreground" role="status">
                  This task uses a legacy interval below one minute. Saving updates it to at least
                  one minute.
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <Label>Schedule</Label>
                <ToggleGroup
                  aria-label="Schedule type"
                  value={[draft.scheduleMode]}
                  onValueChange={(values) => {
                    const mode = values[0] as ScheduleMode | undefined;
                    if (
                      mode === "fixed" ||
                      mode === "interval" ||
                      mode === "webhook" ||
                      mode === "idle"
                    )
                      setDraft((current) => ({
                        ...current,
                        scheduleMode: mode,
                        prompt:
                          mode === "webhook" && !current.prompt.trim()
                            ? DEFAULT_WEBHOOK_PROMPT
                            : current.prompt,
                      }));
                  }}
                >
                  <Toggle value="fixed">At a time</Toggle>
                  <Toggle value="interval">Every interval</Toggle>
                  <Toggle value="webhook">On webhook</Toggle>
                  <Toggle value="idle">When idle</Toggle>
                </ToggleGroup>
              </div>

              {draft.scheduleMode === "webhook" ? (
                <div className="space-y-4">
                  <WebhookEndpointField environmentId={environmentId} task={liveTask} />
                  <p className="text-xs text-muted-foreground">
                    {
                      "Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent."
                    }
                  </p>
                  <Field
                    label="Skip requests older than"
                    hint="minutes, optional"
                    htmlFor="scheduled-task-max-age"
                  >
                    <Input
                      id="scheduled-task-max-age"
                      type="number"
                      nativeInput
                      min={1}
                      max={MAX_WEBHOOK_DELIVERY_AGE_MINUTES}
                      placeholder="Run every request"
                      value={draft.maxDeliveryAgeMinutes}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          maxDeliveryAgeMinutes: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <WebhookFiltersField
                    filters={draft.filters}
                    onChange={(filters) => setDraft((current) => ({ ...current, filters }))}
                  />
                  <Field
                    label="Replay key"
                    hint="template, optional"
                    htmlFor="scheduled-task-replay-key"
                  >
                    <Input
                      id="scheduled-task-replay-key"
                      placeholder="{{headers.delivery-id}}"
                      value={draft.replayKey}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, replayKey: event.target.value }))
                      }
                    />
                  </Field>
                  <Field
                    label="Coalesce key"
                    hint="template, optional"
                    htmlFor="scheduled-task-coalesce-key"
                  >
                    <Input
                      id="scheduled-task-coalesce-key"
                      placeholder="{{body.id}}"
                      value={draft.coalesceKey}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, coalesceKey: event.target.value }))
                      }
                    />
                  </Field>
                  <Field
                    label="Coalesce window"
                    hint="seconds, 10–3600"
                    htmlFor="scheduled-task-coalesce-window"
                  >
                    <Input
                      id="scheduled-task-coalesce-window"
                      type="number"
                      nativeInput
                      min={10}
                      max={3600}
                      placeholder="120"
                      value={draft.coalesceWindowSeconds}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          coalesceWindowSeconds: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <p className="text-xs text-muted-foreground">
                    Replay keys suppress repeat deliveries for 7 days. Coalescing runs the latest
                    payload once when the window from the first delivery closes. Empty keys run
                    normally.
                  </p>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="scheduled-task-signature">Require signature</Label>
                      <p className="text-sm text-muted-foreground">
                        Reject requests without a valid HMAC-SHA256 signature of the body.
                      </p>
                    </div>
                    <Switch
                      id="scheduled-task-signature"
                      checked={draft.signatureEnabled}
                      onCheckedChange={(signatureEnabled) =>
                        setDraft((current) => ({ ...current, signatureEnabled }))
                      }
                    />
                  </div>
                  {draft.signatureEnabled ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Header" htmlFor="scheduled-task-signature-header">
                        <Input
                          id="scheduled-task-signature-header"
                          value={draft.signatureHeader}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              signatureHeader: event.target.value,
                            }))
                          }
                        />
                      </Field>
                      <Field label="Prefix" htmlFor="scheduled-task-signature-prefix">
                        <Input
                          id="scheduled-task-signature-prefix"
                          value={draft.signaturePrefix}
                          placeholder="None"
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              signaturePrefix: event.target.value,
                            }))
                          }
                        />
                      </Field>
                      <Field label="Encoding" htmlFor="scheduled-task-signature-encoding">
                        <Select
                          value={draft.signatureEncoding}
                          onValueChange={(value) =>
                            setDraft((current) => ({
                              ...current,
                              signatureEncoding: value === "base64" ? "base64" : "hex",
                            }))
                          }
                        >
                          <SelectTrigger size="sm" id="scheduled-task-signature-encoding">
                            <SelectValue>{draft.signatureEncoding}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            <SelectItem value="hex">hex</SelectItem>
                            <SelectItem value="base64">base64</SelectItem>
                          </SelectPopup>
                        </Select>
                      </Field>
                      <Field label="Secret" htmlFor="scheduled-task-signature-secret">
                        <Input
                          id="scheduled-task-signature-secret"
                          type="password"
                          autoComplete="off"
                          value={draft.signatureSecret}
                          placeholder={
                            liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret
                              ? "Unchanged"
                              : "Shared secret"
                          }
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              signatureSecret: event.target.value,
                            }))
                          }
                        />
                      </Field>
                    </div>
                  ) : null}
                </div>
              ) : draft.scheduleMode === "fixed" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="scheduled-task-time">Run at</Label>
                    <Input
                      type="time"
                      id="scheduled-task-time"
                      nativeInput
                      className="w-32"
                      value={draft.timeOfDay}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">on</span>
                  </div>
                  <ToggleGroup
                    multiple
                    variant="outline"
                    size="sm"
                    aria-label="Days to run"
                    value={[...draft.weekdays].map(String)}
                    onValueChange={(values) => {
                      if (values.length === 0) return;
                      setDraft((current) => ({
                        ...current,
                        weekdays: new Set(values.map(Number)),
                      }));
                    }}
                  >
                    {WEEKDAY_ORDER.map((day) => (
                      <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
                        {WEEKDAY_SHORT[day]}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>
              ) : draft.scheduleMode === "idle" ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor="scheduled-task-idle-thread">Send to</Label>
                    <Select
                      value={
                        draft.idleAllOpenThreads
                          ? draft.idleProjectOnly
                            ? PROJECT_OPEN_THREADS
                            : ALL_OPEN_THREADS
                          : draft.threadId
                      }
                      onValueChange={(threadId) =>
                        setDraft((current) => ({
                          ...current,
                          idleAllOpenThreads:
                            threadId === ALL_OPEN_THREADS || threadId === PROJECT_OPEN_THREADS,
                          idleProjectOnly: threadId === PROJECT_OPEN_THREADS,
                          threadId:
                            threadId === ALL_OPEN_THREADS || threadId === PROJECT_OPEN_THREADS
                              ? ""
                              : (threadId ?? ""),
                        }))
                      }
                    >
                      <SelectTrigger size="sm" id="scheduled-task-idle-thread" className="w-56">
                        <SelectValue placeholder="Choose a thread">
                          {draft.idleAllOpenThreads
                            ? draft.idleProjectOnly
                              ? "Open threads of this project"
                              : "All open threads"
                            : idleThreads.find((thread) => thread.id === draft.threadId)?.title}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value={ALL_OPEN_THREADS}>All open threads</SelectItem>
                        <SelectItem value={PROJECT_OPEN_THREADS}>
                          Open threads of this project
                        </SelectItem>
                        {idleThreads.map((thread) => (
                          <SelectItem key={thread.id} value={thread.id}>
                            {thread.title}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    {draft.idleAllOpenThreads ? (
                      <>
                        <Label htmlFor="scheduled-task-idle-parallel">
                          that stand still, while fewer than
                        </Label>
                        <Input
                          id="scheduled-task-idle-parallel"
                          type="number"
                          nativeInput
                          min={1}
                          max={10}
                          step={1}
                          className="w-20"
                          value={draft.idleMaxParallel}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              idleMaxParallel: event.target.value,
                            }))
                          }
                        />
                        <span className="text-xs text-muted-foreground">are at work</span>
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                size="xs"
                                variant="outline"
                                aria-label="Threads this task leaves out"
                              />
                            }
                          >
                            {draft.idleExcludeThreadIds.length === 0
                              ? "Leaves out no thread"
                              : `Leaves out ${draft.idleExcludeThreadIds.length} ${draft.idleExcludeThreadIds.length === 1 ? "thread" : "threads"}`}
                          </MenuTrigger>
                          <MenuPopup align="start">
                            {excludableThreads.length === 0 ? (
                              <MenuItem disabled>No open threads</MenuItem>
                            ) : (
                              excludableThreads.map((thread) => (
                                <MenuCheckboxItem
                                  key={thread.id}
                                  checked={draft.idleExcludeThreadIds.includes(thread.id)}
                                  closeOnClick={false}
                                  onCheckedChange={(checked) =>
                                    setDraft((current) => ({
                                      ...current,
                                      idleExcludeThreadIds: checked
                                        ? [...current.idleExcludeThreadIds, thread.id]
                                        : current.idleExcludeThreadIds.filter(
                                            (id) => id !== thread.id,
                                          ),
                                    }))
                                  }
                                >
                                  {thread.title}
                                </MenuCheckboxItem>
                              ))
                            )}
                          </MenuPopup>
                        </Menu>
                        <div className="flex w-full items-center gap-2">
                          <Switch
                            checked={draft.idleSupervise}
                            onCheckedChange={(checked) =>
                              setDraft((current) => ({
                                ...current,
                                idleSupervise: Boolean(checked),
                              }))
                            }
                            aria-label="Only send on threads that do not need me"
                          />
                          <span className="text-xs text-muted-foreground">
                            Only send on threads that do not need me: a model reads each last reply
                            and tells the agent to go on where it merely asked for leave. The prompt
                            above is not sent. At most twice per thread until you write in it again.
                          </span>
                        </div>
                      </>
                    ) : null}
                    {draft.idleAllOpenThreads ? null : (
                      <Label htmlFor="scheduled-task-idle-watch">when</Label>
                    )}
                    {draft.idleAllOpenThreads ? null : (
                      <Select
                        value={draft.idleWatchThreadId}
                        onValueChange={(threadId) =>
                          setDraft((current) => ({ ...current, idleWatchThreadId: threadId ?? "" }))
                        }
                      >
                        <SelectTrigger size="sm" id="scheduled-task-idle-watch" className="w-56">
                          <SelectValue>
                            {draft.idleWatchThreadId === ""
                              ? "that thread finishes"
                              : `"${idleThreads.find((thread) => thread.id === draft.idleWatchThreadId)?.title ?? "another thread"}" finishes`}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="">that thread finishes</SelectItem>
                          {idleThreads.map((thread) => (
                            <SelectItem key={thread.id} value={thread.id}>
                              {thread.title}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor="scheduled-task-idle-runs">Run up to</Label>
                    <Input
                      type="number"
                      id="scheduled-task-idle-runs"
                      nativeInput
                      min={1}
                      max={500}
                      step={1}
                      className="w-20"
                      value={draft.idleMaxRuns}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, idleMaxRuns: event.target.value }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">times, waiting at least</span>
                    <Input
                      type="number"
                      aria-label="Minutes to wait after a run ends"
                      nativeInput
                      min={0}
                      step="any"
                      className="w-20"
                      value={draft.idlePauseMinutes}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          idlePauseMinutes: event.target.value,
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">minutes after each run</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor="scheduled-task-idle-stop">Stop when the reply contains</Label>
                    <Input
                      id="scheduled-task-idle-stop"
                      nativeInput
                      maxLength={80}
                      placeholder="Optional, e.g. ALL DONE"
                      className="w-56"
                      value={draft.idleStopPhrase}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, idleStopPhrase: event.target.value }))
                      }
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor="scheduled-task-idle-budget">
                      Stop when the account has under
                    </Label>
                    <Input
                      type="number"
                      id="scheduled-task-idle-budget"
                      nativeInput
                      min={1}
                      max={99}
                      step={1}
                      placeholder="off"
                      className="w-20"
                      value={draft.idleMinRemainingPercent}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          idleMinRemainingPercent: event.target.value,
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">
                      percent of its tightest usage window left
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {draft.idleAllOpenThreads
                      ? "Sends the prompt to open threads that stand still, most recently finished first, once per finished run. Runs count over all threads."
                      : "Sends the prompt each time the chosen thread finishes and nothing waits on you. Needs a thread."}{" "}
                    The task turns itself off after the last run; saving or enabling it starts the
                    count again.
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Label htmlFor="scheduled-task-interval">Run every</Label>
                  <Input
                    type="number"
                    id="scheduled-task-interval"
                    nativeInput
                    min={1}
                    step="any"
                    className="w-24"
                    value={draft.intervalMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">minutes</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <Label htmlFor="scheduled-task-enabled">Enabled</Label>
                <p
                  id="scheduled-task-enabled-description"
                  className="text-sm text-muted-foreground"
                >
                  Disabled tasks stay saved but do not run.
                </p>
              </div>
              <Switch
                id="scheduled-task-enabled"
                aria-describedby="scheduled-task-enabled-description"
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
            </div>
          </fieldset>
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!canOperate || saving || editingTaskMissing || !connected || !tasksQuery.data}
            onClick={() => void submit()}
          >
            {draft.editingId ? "Save task" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
