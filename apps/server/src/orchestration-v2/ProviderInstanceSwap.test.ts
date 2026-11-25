import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestratorProviderSelectionBusyError } from "./Orchestrator.ts";
import * as ProviderInstanceSwap from "./ProviderInstanceSwap.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const oneNeutrino = ProviderInstanceId.make("codex");
const stark = ProviderInstanceId.make("codex_stark_cli");
const claude = ProviderInstanceId.make("claudeAgent");
const projectId = ProjectId.make("project:swap");

const astra: ModelSelection = {
  instanceId: oneNeutrino,
  model: "gpt-6.2-astra",
  options: [
    { id: "reasoningEffort", value: "ultra" },
    { id: "serviceTier", value: "fast" },
    { id: "cyberAccessProgram", value: true },
  ],
};

const providers = [
  { instanceId: oneNeutrino, driver: "codex", enabled: true },
  { instanceId: stark, driver: "codex", enabled: true },
  { instanceId: ProviderInstanceId.make("codex_off"), driver: "codex", enabled: false },
  { instanceId: claude, driver: "claudeAgent", enabled: true },
];

const thread = (id: string, modelSelection: ModelSelection, activeRunId: string | null = null) =>
  ({
    id: ThreadId.make(id),
    projectId,
    modelSelection,
    activeRunId,
    deletedAt: null,
  }) as never;

const insertTask = (
  sql: SqlClient.SqlClient,
  id: string,
  threadId: string | null,
  modelSelection: ModelSelection,
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: id,
    title: "task",
    prompt: "Run task",
    enabled: 0,
    schedule_json: '{"type":"interval","everyMs":60000}',
    project_id: projectId,
    thread_id: threadId,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: JSON.stringify(modelSelection),
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: "2026-11-25T12:00:00.000Z",
    updated_at: "2026-11-25T12:00:00.000Z",
    next_run_at: null,
    last_run_at: null,
    last_run_status: "never",
    last_run_error: null,
    run_count: 0,
  })}`;

const harness = (dispatched: Array<OrchestrationV2ServerCommand>) =>
  ProviderInstanceSwap.layer.pipe(
    Layer.provideMerge(ScheduledTaskService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              threads: [
                thread("thread:idle", astra),
                thread("thread:running", astra, "run:1"),
                thread("thread:started-since", astra),
                thread("thread:claude", { instanceId: claude, model: "claude-opus-5-5" }),
              ],
            } as never),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          dispatch: (command) =>
            Effect.suspend(() => {
              if (
                command.type === "thread.model-selection.set" &&
                command.threadId === "thread:started-since"
              ) {
                return Effect.fail(
                  new OrchestratorProviderSelectionBusyError({
                    commandId: command.commandId,
                    threadId: command.threadId,
                  }),
                );
              }
              dispatched.push(command);
              return Effect.succeed({ sequence: dispatched.length } as never);
            }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(providers as never),
        }),
        // The text generation model falls back from an instance the settings do not know.
        ServerSettings.layerTest({
          providerInstances: { [stark]: { driver: "codex", config: {} } },
        } as never),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        ManagedPolicy.layerTest(),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
  );

it.effect(
  "moves idle threads, tasks and the text generation model to the other account and back, keeping model and options",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertTask(sql, "task:unbound", null, astra);
      yield* insertTask(sql, "task:bound", "thread:idle", astra);
      yield* insertTask(sql, "task:claude", null, { instanceId: claude, model: "claude-opus-5-5" });
      const dispatched: Array<OrchestrationV2ServerCommand> = [];

      yield* Effect.gen(function* () {
        const swap = yield* ProviderInstanceSwap.ProviderInstanceSwap;
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ textGenerationModelSelection: astra });
        const selectionOf = (taskId: string) =>
          tasks
            .list()
            .pipe(
              Effect.map(
                ({ tasks: all }) => all.find((task) => task.id === taskId)?.modelSelection,
              ),
            );

        const result = yield* swap.swap({
          commandId: CommandId.make("swap:1"),
          fromInstanceId: oneNeutrino,
          toInstanceId: stark,
          includeTextGeneration: true,
        });
        expect(result).toEqual({
          moved: 1,
          busy: ["thread:running", "thread:started-since"],
          failed: [],
          scheduledTasksMoved: 2,
          textGenerationMoved: true,
        });
        expect(dispatched).toEqual([
          {
            type: "thread.model-selection.set",
            commandId: "swap:1:swap:thread:idle",
            threadId: "thread:idle",
            modelSelection: { ...astra, instanceId: stark },
            includeQueuedRuns: true,
          },
        ]);
        expect(yield* selectionOf("task:unbound")).toEqual({ ...astra, instanceId: stark });
        expect(yield* selectionOf("task:bound")).toEqual({ ...astra, instanceId: stark });
        expect((yield* selectionOf("task:claude"))?.instanceId).toBe(claude);
        expect((yield* settings.getSettings).textGenerationModelSelection).toEqual({
          ...astra,
          instanceId: stark,
        });

        // The way back is the same call with the instances exchanged.
        const back = yield* swap.swap({
          commandId: CommandId.make("swap:2"),
          fromInstanceId: stark,
          toInstanceId: oneNeutrino,
          includeTextGeneration: true,
        });
        expect(back.scheduledTasksMoved).toBe(2);
        expect(back.textGenerationMoved).toBe(true);
        expect(yield* selectionOf("task:unbound")).toEqual(astra);
        expect((yield* settings.getSettings).textGenerationModelSelection).toEqual(astra);

        // Another provider is not another account: nothing moves.
        const crossDriver = yield* Effect.exit(
          swap.swap({
            commandId: CommandId.make("swap:3"),
            fromInstanceId: oneNeutrino,
            toInstanceId: claude,
          }),
        );
        assert.isTrue(Exit.isFailure(crossDriver));
        expect(dispatched).toHaveLength(1);
        expect(yield* selectionOf("task:unbound")).toEqual(astra);
      }).pipe(Effect.provide(harness(dispatched)), Effect.scoped);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.each([
  ["codex", "claudeAgent", "different providers"],
  ["codex", "codex_off", "turned off"],
  ["codex", "codex_missing", "Unknown provider instance"],
  ["codex_missing", "codex", "Unknown provider instance"],
  ["codex", "codex", "another account"],
])("refuses a swap from %s to %s", (from, to, message) => {
  expect(ProviderInstanceSwap.swapRefusal(providers, from, to)).toContain(message);
});

it("allows a swap between two accounts of the same provider", () => {
  expect(ProviderInstanceSwap.swapRefusal(providers, "codex", "codex_stark_cli")).toBeNull();
});
