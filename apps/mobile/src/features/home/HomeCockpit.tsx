import { useAtomValue } from "@effect/atom-react";
import {
  deriveCockpitAlerts,
  formatTokens,
  formatWait,
  HEAVY_CONTEXT_TOKENS,
} from "@t3tools/client-runtime/state/cockpit-alerts";
import {
  formatAutomationsSummary,
  summarizeAutomations,
} from "@t3tools/client-runtime/state/thread-automations";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { openSettings } from "../settings/settings-navigation";

export function HomeCockpit({
  environmentId,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly nowMs: number;
}) {
  const input = useMemo(() => ({}), []);
  const result = useAtomValue(serverEnvironment.threadChecklists({ environmentId, input }));
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "resume queues");
  const navigation = useNavigation();
  const tasks = useEnvironmentQuery(serverEnvironment.scheduledTasksLive({ environmentId, input }))
    .data?.tasks;
  const automations = formatAutomationsSummary(
    summarizeAutomations({
      tasks: tasks ?? [],
      paused: settings?.scheduledTasksPaused === true,
      exemptIds: settings?.scheduledTasksPauseExemptIds ?? [],
    }),
    nowMs,
  );
  const alerts = deriveCockpitAlerts(Option.getOrNull(AsyncResult.value(result)), nowMs);
  const { questions, quietRuns, heavyContexts, waitingQueues } = alerts;
  const warnings = [
    alerts.updateHoldMs === null
      ? null
      : `An update is waiting to go in: tasks start again in ${formatWait(alerts.updateHoldMs)} at the latest`,
    questions === null
      ? null
      : `${questions.threadIds.size} ${questions.threadIds.size === 1 ? "thread waits" : "threads wait"} for your answer, the longest for ${formatWait(questions.longestMs)}`,
    quietRuns === null
      ? null
      : `${quietRuns.threadIds.size} running ${quietRuns.threadIds.size === 1 ? "turn" : "turns"} without a sign of life for ${formatWait(quietRuns.longestMs)}`,
    waitingQueues === null || !waitingQueues.stale
      ? null
      : queuesLine(waitingQueues.messages, waitingQueues.threadIds.size, waitingQueues.oldestMs),
  ].filter((line) => line !== null);
  const notes = [
    waitingQueues === null || waitingQueues.stale
      ? null
      : queuesLine(waitingQueues.messages, waitingQueues.threadIds.size, waitingQueues.oldestMs),
    heavyContexts === null
      ? null
      : `${heavyContexts.threadIds.size} ${heavyContexts.threadIds.size === 1 ? "thread carries" : "threads carry"} over ${formatTokens(HEAVY_CONTEXT_TOKENS)} context, the largest ${formatTokens(heavyContexts.largestTokens)}: compact or start a new thread`,
  ].filter((line) => line !== null);
  const queuesPaused = settings?.threadQueuesPaused === true;
  if (warnings.length === 0 && notes.length === 0 && !queuesPaused && automations === null) {
    return null;
  }
  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-border bg-screen p-3">
      {warnings.map((line) => (
        <Text key={line} className="text-sm font-medium text-warning-foreground">
          {line}
        </Text>
      ))}
      {notes.map((line) => (
        <Text key={line} className="text-sm text-foreground-muted">
          {line}
        </Text>
      ))}
      {automations === null ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={() => openSettings(navigation, "SettingsScheduledTasks")}
          className="active:opacity-70"
        >
          <Text className="text-sm text-foreground-muted">{automations}</Text>
        </Pressable>
      )}
      {queuesPaused ? (
        <View className="flex-row items-center justify-between gap-2">
          <Text className="text-sm text-foreground-muted">Queues are paused</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              void updateSettings({
                environmentId,
                input: { patch: { threadQueuesPaused: false } },
              })
            }
            className="rounded-lg bg-subtle px-3 py-1.5 active:opacity-70"
          >
            <Text className="text-sm text-foreground">Resume queues</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function queuesLine(messages: number, threads: number, oldestMs: number): string {
  return `${messages} ${messages === 1 ? "message waits" : "messages wait"} in ${threads} ${threads === 1 ? "thread" : "threads"}, oldest ${formatWait(oldestMs)}`;
}
