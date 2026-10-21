import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";
import { McpServer } from "effect/ai";
import { McpSchema } from "effect/ai";
import * as McpHttpServer from "../../McpHttpServer.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

const caller: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:preferences",
  thread: {
    threadId,
    providerSessionId: "provider:preferences",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const layerEnvironment = Layer.mock(Environment.ServerEnvironment)({
  getDescriptor: Effect.succeed({
    environmentId,
    label: "Test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: false },
  }),
});

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

it("names the pauses a patch would lift, and nothing when it sets one or leaves them", () => {
  const paused = { scheduledTasksPaused: true, threadQueuesPaused: true };
  const running = { scheduledTasksPaused: false, threadQueuesPaused: false };
  expect(EnvironmentHandlers.liftedPauses({ scheduledTasksPaused: false }, paused)).toEqual([
    "scheduledTasksPaused",
  ]);
  expect(
    EnvironmentHandlers.liftedPauses(
      { scheduledTasksPaused: false, threadQueuesPaused: false },
      paused,
    ),
  ).toEqual(["scheduledTasksPaused", "threadQueuesPaused"]);
  // Setting a pause, repeating "off" where nothing is paused, or leaving the fields out is fine.
  expect(EnvironmentHandlers.liftedPauses({ scheduledTasksPaused: true }, running)).toEqual([]);
  expect(EnvironmentHandlers.liftedPauses({ scheduledTasksPaused: false }, running)).toEqual([]);
  expect(EnvironmentHandlers.liftedPauses({}, paused)).toEqual([]);
});

it.effect("lets a thread set a pause and refuses to let it lift one", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const settings = yield* Settings.ServerSettingsService;
    const call = (args: Record<string, unknown>) =>
      server.callTool({ name: "t3_environment_preferences_update", arguments: args }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
        Effect.provideService(
          McpSchema.McpServerClient,
          McpSchema.McpServerClient.of({
            clientId: 1,
            protocolVersion: "2025-06-18",
            clientCapabilities: {},
            clientInfo: { name: "preferences", version: "1" },
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "preferences", version: "1" },
            },
            getClient: Effect.die("unused"),
          }),
        ),
      );
    expect((yield* call({ scheduledTasksPaused: true, threadQueuesPaused: true })).isError).toBe(
      false,
    );
    for (const lift of [{ scheduledTasksPaused: false }, { threadQueuesPaused: false }]) {
      expect((yield* call(lift)).isError).toBe(true);
    }
    // Another preference still goes through while the pauses stay on.
    expect((yield* call({ newWorktreesStartFromOrigin: true })).isError).toBe(false);
    const after = yield* settings.getSettings;
    expect(after.scheduledTasksPaused).toBe(true);
    expect(after.threadQueuesPaused).toBe(true);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerEnvironmentToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          }),
        ),
        Layer.provide(layerEnvironment),
        Layer.provideMerge(Settings.layerTest()),
      ),
    ),
  ),
);
