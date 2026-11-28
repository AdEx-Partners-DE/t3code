import { CommandId, OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ProviderInstanceSwap from "../../../orchestration-v2/ProviderInstanceSwap.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    switchAccountAtUsageLimit,
    retryInstantFailures,
    scheduledTasksPaused,
    threadQueuesPaused,
    continueThreadsAfterServerUpdate,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    switchAccountAtUsageLimit,
    retryInstantFailures,
    scheduledTasksPaused,
    threadQueuesPaused,
    continueThreadsAfterServerUpdate,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
/**
 * The pauses a patch would lift. A pause is the user's stop sign for work
 * that runs without them; an agent held back by one must not remove it.
 */
export function liftedPauses(
  patch: { readonly scheduledTasksPaused?: boolean; readonly threadQueuesPaused?: boolean },
  current: Pick<ServerSettings, "scheduledTasksPaused" | "threadQueuesPaused">,
): ReadonlyArray<string> {
  return [
    ...(current.scheduledTasksPaused && patch.scheduledTasksPaused === false
      ? ["scheduledTasksPaused"]
      : []),
    ...(current.threadQueuesPaused && patch.threadQueuesPaused === false
      ? ["threadQueuesPaused"]
      : []),
  ];
}

const GB = 1e9;
const gigabytes = (bytes: number) => Math.round((bytes / GB) * 10) / 10;

const machine = Effect.gen(function* () {
  const hostResources = yield* HostResources.HostResources;
  const [snapshot, pressure] = yield* Effect.all([hostResources.read, hostResources.readPressure], {
    concurrency: "unbounded",
  });
  return {
    pressure: {
      memory: pressure.memory,
      cpu: pressure.cpu,
      io: pressure.io,
      disk: pressure.disk,
    },
    cpuCount: snapshot.cpuCount,
    cpuUsedPercent:
      snapshot.cpuUtilization === null ? null : Math.round(snapshot.cpuUtilization * 100),
    memoryAvailableGb: gigabytes(snapshot.availableMemoryBytes),
    memoryTotalGb: gigabytes(snapshot.totalMemoryBytes),
    diskFreeGb:
      snapshot.diskFreeBytes === undefined || snapshot.diskFreeBytes === null
        ? null
        : gigabytes(snapshot.diskFreeBytes),
  };
});
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
        machine: yield* machine,
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        const lifted = liftedPauses(
          patch,
          yield* settings.getSettings.pipe(Effect.mapError(unavailable)),
        );
        if (scope.thread !== undefined && lifted.length > 0) {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: `The user paused this (${lifted.join(", ")}). Only the user can lift a pause, in Settings. Do not work around it: say that the pause is on and stop.`,
          });
        }
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
  t3_provider_instance_swap: McpToolAccess.writesEnvironment(({ environmentId: _, ...input }) =>
    Effect.gen(function* () {
      yield* access;
      const swap = yield* ProviderInstanceSwap.ProviderInstanceSwap;
      const at = yield* Clock.currentTimeMillis;
      const commandId = CommandId.make(
        `mcp:provider-swap:${input.fromInstanceId}:${input.toInstanceId}:${at}`,
      );
      return yield* swap
        .swap({ ...input, commandId })
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProviderInstanceSwapError"
              ? new OrchestratorMcpFailure({ code: "invalid_request", message: cause.detail })
              : unavailable(),
          ),
        );
    }),
  ),
});
