import { useAtomValue } from "@effect/atom-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, PencilIcon, PlayIcon, Settings2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatAutomationsSummary,
  relatedThreadAutomations,
  summarizeAutomations,
  type ThreadAutomationReason,
} from "@t3tools/client-runtime/state/thread-automations";

import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { cn } from "../../lib/utils";
import { ScheduledRelativeLabel, scheduleLabel } from "../settings/ScheduledTasksSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { isTaskHeldByPause } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

import { readEnvironmentScope } from "../../state/session";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-muted-foreground/40",
  running: "bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
};

function taskScheduleLine(
  task: ScheduledTask,
  timeZone: string | undefined,
  held: boolean,
  nowMs: number,
) {
  return (
    <>
      {scheduleLabel(task.schedule, timeZone)}
      {!task.enabled ? (
        " · off"
      ) : held ? (
        task.nextRunAt !== null && Date.parse(task.nextRunAt) <= nowMs ? (
          <>
            {" · paused with all tasks, due since "}
            <ScheduledRelativeLabel value={task.nextRunAt} />
          </>
        ) : (
          " · paused with all tasks"
        )
      ) : task.nextRunAt !== null ? (
        <>
          {" · next "}
          <ScheduledRelativeLabel value={task.nextRunAt} />
        </>
      ) : (
        ""
      )}
    </>
  );
}

const RELATED_REASON_LABEL: Record<ThreadAutomationReason, string> = {
  "covers-open-threads": "Sends to all open threads",
  "waits-for-thread": "Starts when this thread finishes",
  running: "Running in its own thread",
};

/**
 * Thread details panel section listing the automations (scheduled tasks) bound
 * to this thread, the ones that send to it or wait for it, any task running
 * elsewhere, and one line saying how many are on and which starts next. Fed by
 * the live scheduled-task subscription, so run status and next-run times update
 * as the scheduler works — no manual refresh. Renders nothing when no task is
 * on and none concerns this thread.
 */
export function ThreadAutomationsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(props.environmentId),
  );
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "thread automation toggle",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread automation run now",
  });
  const navigate = useNavigate();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  // The environment-wide pause holds every task, whatever its own switch says.
  const allTasksPaused = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.scheduledTasksPaused,
  );
  const pauseExemptIds = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.scheduledTasksPauseExemptIds,
  );
  const isHeld = (task: ScheduledTask) =>
    task.enabled && isTaskHeldByPause(task.id, allTasksPaused, pauseExemptIds);

  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const thread = useThreadShell(threadRef);
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);

  const tasks = tasksQuery.data?.tasks ?? [];
  const boundTasks = tasks.filter((task) => task.threadId === props.threadId);
  const relatedTasks = relatedThreadAutomations({ tasks, threadId: props.threadId, thread });
  const summary = formatAutomationsSummary(
    summarizeAutomations({ tasks, paused: allTasksPaused, exemptIds: pauseExemptIds }),
    nowMs,
  );
  // A load error must not look like "no automations" — this thread may have
  // tasks whose controls would silently vanish. Only hide the section when we
  // positively know nothing is on and nothing concerns this thread.
  if (
    tasksQuery.error === null &&
    boundTasks.length === 0 &&
    relatedTasks.length === 0 &&
    summary === null
  ) {
    return null;
  }

  const openTask = (task: ScheduledTask) => {
    if (task.threadId === null) {
      void navigate({
        to: "/settings/scheduled-tasks",
        search: { environmentId: props.environmentId, taskId: task.id },
      });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, task.threadId)),
    });
  };

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const toggleEnabled = async (task: ScheduledTask, enabled: boolean) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    // Partial update: only the enabled flag changes, so a toggle can never
    // revert concurrent edits made to the task elsewhere.
    const result = await setTaskEnabled({
      environmentId: props.environmentId,
      input: { id: task.id, enabled },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not update automation", squashAtomCommandFailure(result));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await runTaskNow({
      environmentId: props.environmentId,
      input: { id: task.id },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not run automation", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-automations-heading"
      title="Automations"
      data-thread-automations-panel
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label="Manage scheduled tasks"
                onClick={() =>
                  void navigate({
                    to: "/settings/scheduled-tasks",
                    search: { environmentId: props.environmentId },
                  })
                }
              >
                <Settings2Icon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>Manage scheduled tasks</TooltipPopup>
        </Tooltip>
      }
    >
      {tasksQuery.error !== null ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          Could not load automations: {tasksQuery.error}
        </p>
      ) : null}

      {boundTasks.some(isHeld) ? (
        <div
          className={cn(
            "flex items-center justify-between gap-2 py-1 text-2xs text-warning-foreground",
            THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
          )}
          data-testid="thread-automations-paused"
        >
          <span>Paused by "Pause all tasks". Switch a task on to resume just that one.</span>
        </div>
      ) : null}

      <ul className="m-0 list-none p-0">
        {boundTasks.map((task) => (
          <li
            key={task.id}
            className={cn(
              "group flex items-center rounded-lg py-1.5",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
              <CalendarClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span
                className={cn(
                  "absolute -right-1 -top-1 size-1.5 rounded-full",
                  STATUS_DOT_CLASS[task.lastRunStatus],
                )}
                aria-hidden
              />
            </span>
            <Tooltip>
              <TooltipTrigger render={<div className="min-w-0 flex-1" />}>
                <span className="block truncate text-sm font-medium text-foreground/80">
                  {task.title}
                </span>
                <p className="truncate text-2xs text-muted-foreground">
                  {taskScheduleLine(task, tasksQuery.data?.timeZone, isHeld(task), nowMs)}
                </p>
              </TooltipTrigger>
              <TooltipPopup side="left">
                <p className="font-medium">{task.title}</p>
                <p className="text-muted-foreground">
                  {taskScheduleLine(task, tasksQuery.data?.timeZone, isHeld(task), nowMs)}
                </p>
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={`Edit ${task.title}`}
                    onClick={() =>
                      void navigate({
                        to: "/settings/scheduled-tasks",
                        search: { environmentId: props.environmentId, taskId: task.id },
                      })
                    }
                  >
                    <PencilIcon className="size-3.5" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup>Edit automation</TooltipPopup>
            </Tooltip>
            {/* A webhook task runs from its URL; there is no request to run it with. */}
            {task.schedule.type === "webhook" ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={`Run ${task.title} now`}
                      disabled={
                        !canOperate || busyTaskId !== null || task.lastRunStatus === "running"
                      }
                      onClick={() => void runNow(task)}
                    >
                      <PlayIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>Run now</TooltipPopup>
              </Tooltip>
            )}
            <Switch
              // The switch shows what the scheduler does: a task held by
              // "Pause all tasks" reads off, and switching it on resumes it.
              checked={task.enabled && !isHeld(task)}
              disabled={!canOperate || busyTaskId !== null}
              aria-label={
                task.enabled && !isHeld(task) ? `Turn off ${task.title}` : `Turn on ${task.title}`
              }
              onCheckedChange={(enabled) => void toggleEnabled(task, enabled)}
            />
          </li>
        ))}
        {relatedTasks.map(({ task, reason }) => (
          <li key={task.id}>
            <button
              type="button"
              data-testid="thread-automations-related"
              onClick={() => openTask(task)}
              className={cn(
                "flex w-full cursor-pointer items-center rounded-lg py-1.5 text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            >
              <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
                <CalendarClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                <span
                  className={cn(
                    "absolute -right-1 -top-1 size-1.5 rounded-full",
                    STATUS_DOT_CLASS[task.lastRunStatus],
                  )}
                  aria-hidden
                />
              </span>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground/80">{task.title}</span>
                <p className="truncate text-2xs text-muted-foreground">
                  {RELATED_REASON_LABEL[reason]}
                  {reason !== "running" && task.lastRunStatus === "running" ? " · running now" : ""}
                  {reason !== "running" && isHeld(task) ? " · paused with all tasks" : ""}
                </p>
              </div>
            </button>
          </li>
        ))}
      </ul>

      {summary !== null ? (
        <button
          type="button"
          data-testid="thread-automations-summary"
          onClick={() =>
            void navigate({
              to: "/settings/scheduled-tasks",
              search: { environmentId: props.environmentId },
            })
          }
          className={cn(
            "block w-full cursor-pointer truncate py-1 text-left text-2xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
            THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
          )}
        >
          {summary}
        </button>
      ) : null}
    </ThreadDetailsSection>
  );
}
