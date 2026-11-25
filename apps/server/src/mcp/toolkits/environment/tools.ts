import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  OrchestrationV2RpcSchemas,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ProviderInstanceSwap from "../../../orchestration-v2/ProviderInstanceSwap.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  switchAccountAtUsageLimit: ServerSettings.fields.switchAccountAtUsageLimit,
  retryInstantFailures: ServerSettings.fields.retryInstantFailures,
  scheduledTasksPaused: ServerSettings.fields.scheduledTasksPaused,
  threadQueuesPaused: ServerSettings.fields.threadQueuesPaused,
  continueThreadsAfterServerUpdate: ServerSettings.fields.continueThreadsAfterServerUpdate,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    ProviderInstanceSwap.ProviderInstanceSwap,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it. `scheduledTasksPaused` and `threadQueuesPaused` can be turned on from a thread but not off: only the user lifts a pause.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    switchAccountAtUsageLimit: ServerSettingsPatch.fields.switchAccountAtUsageLimit,
    retryInstantFailures: ServerSettingsPatch.fields.retryInstantFailures,
    scheduledTasksPaused: ServerSettingsPatch.fields.scheduledTasksPaused,
    threadQueuesPaused: ServerSettingsPatch.fields.threadQueuesPaused,
    continueThreadsAfterServerUpdate: ServerSettingsPatch.fields.continueThreadsAfterServerUpdate,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const ProviderInstanceSwapTool = Tool.make("t3_provider_instance_swap", {
  ...shared,
  description:
    "Move every thread and scheduled task from one instance to another account of the same provider, keeping model and options. Threads mid-run, this one included, stay and come back as `busy`. Same access as preferences.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    fromInstanceId: ProviderInstanceId,
    toInstanceId: ProviderInstanceId,
    includeArchived: Schema.optional(Schema.Boolean),
    includeTextGeneration: Schema.optional(Schema.Boolean),
  }),
  success: OrchestrationV2RpcSchemas.swapProviderInstance.output,
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  ProviderInstanceSwapTool,
);
