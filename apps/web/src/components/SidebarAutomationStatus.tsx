import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useNowMinute } from "../hooks/useNowMinute";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { useEnvironmentQuery } from "../state/query";
import { isTaskHeldByPause } from "@t3tools/contracts";
import { serverEnvironment } from "../state/server";
import { relativeLabel } from "./settings/ScheduledTasksSettings";

/**
 * One line in the sidebar saying what runs without the user: how many
 * scheduled tasks are on, and whether tasks or queues are paused. Shows
 * nothing when there is nothing to say. Clicking opens the task list. The
 * pause of all queues is lifted here, where it is shown for all threads.
 */
export function SidebarAutomationStatus({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  ).data?.tasks;
  const tasksPaused = useEnvironmentSettings(
    environmentId,
    (settings) => settings.scheduledTasksPaused,
  );
  const queuesPaused = useEnvironmentSettings(
    environmentId,
    (settings) => settings.threadQueuesPaused,
  );
  const pauseExemptIds = useEnvironmentSettings(
    environmentId,
    (settings) => settings.scheduledTasksPauseExemptIds,
  );
  const enabled = tasks?.filter((task) => task.enabled) ?? [];
  const enabledCount = enabled.length;
  const held = enabled.filter((task) => isTaskHeldByPause(task.id, tasksPaused, pauseExemptIds));
  const running = enabledCount - held.length;
  // How long the pause has kept work back: the run that has been due longest.
  useNowMinute();
  const oldestDue = tasksPaused
    ? (tasks ?? [])
        .filter(
          (task) =>
            task.enabled &&
            task.nextRunAt !== null &&
            isTaskHeldByPause(task.id, tasksPaused, pauseExemptIds),
        )
        .map((task) => task.nextRunAt!)
        .filter((at) => Date.parse(at) <= Date.now())
        .toSorted()[0]
    : undefined;
  if (enabledCount === 0 && !tasksPaused && !queuesPaused) return null;
  const parts = [
    ...(enabledCount > 0 || tasksPaused
      ? [
          tasksPaused && held.length > 0
            ? `${held.length} ${held.length === 1 ? "automation" : "automations"} paused${oldestDue === undefined ? "" : `, a run has been due since ${relativeLabel(oldestDue)}`}${running > 0 ? ` · ${running} on` : ""}`
            : tasksPaused && enabledCount === 0
              ? // Nothing is on, but the pause still holds any task switched on later.
                "automations paused"
              : `${enabledCount} ${enabledCount === 1 ? "automation" : "automations"} on`,
        ]
      : []),
    ...(queuesPaused ? ["queues paused"] : []),
  ];
  return (
    <div className="mx-0.5 flex items-center gap-1.5 px-2 pb-1 text-2xs text-muted-foreground">
      <button
        type="button"
        data-testid="sidebar-automation-status"
        onClick={() => void navigate({ to: "/settings/scheduled-tasks" })}
        className="min-w-0 cursor-pointer truncate text-left hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        {parts.join(" · ")}
      </button>
      {queuesPaused ? (
        <button
          type="button"
          data-testid="sidebar-resume-queues"
          onClick={() => void updateSettings({ threadQueuesPaused: false })}
          className="shrink-0 cursor-pointer font-medium text-sidebar-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
        >
          Resume queues
        </button>
      ) : null}
    </div>
  );
}
