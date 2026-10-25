import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as DeploymentDrain from "./DeploymentDrain.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorkAdmission from "./WorkAdmission.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const leaseId = "bb379c6e-bede-41f2-8dd3-7977b0a41385";
const projectId = ProjectId.make("project:drain");
const threadId = ThreadId.make("thread:drain");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("This test must not start a provider process"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layerIdleSessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
  get: () => Effect.succeedNone,
});
const runtime = ProviderReplayHarness.layerWithRegistry(
  { name: "deployment-drain" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: database, runEffectWorker: false },
);
const layerTest = Layer.mergeAll(
  runtime,
  WorkAdmission.layer,
  DeploymentDrain.layer.pipe(Layer.provide(runtime)),
  EffectOutbox.layer,
  ThreadManagement.layer.pipe(
    Layer.provide(Layer.mergeAll(runtime, CommandReceiptStore.layer, ServerSettings.layerTest({}))),
  ),
).pipe(Layer.provideMerge(database));

const createThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:drain"),
    threadId,
    projectId,
    title: "Drain test",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

it.effect.each(["manual", "mcp", "timer", "webhook", "run-now"] as const)(
  "waits for an admitted %s message to commit before inspecting active work",
  (entry) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const drain = yield* DeploymentDrain.DeploymentDrain;
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* createThread;
      const beforeCommit = yield* Deferred.make<void>();
      const commitAllowed = yield* Deferred.make<void>();
      const commandId = CommandId.make(`send:${entry}`);
      const commitCommand = sink.commitCommand;
      using _commit = vi
        .spyOn(sink, "commitCommand")
        .mockImplementation((input) =>
          input.commandId === commandId
            ? Deferred.succeed(beforeCommit, undefined).pipe(
                Effect.andThen(Deferred.await(commitAllowed)),
                Effect.andThen(commitCommand(input)),
              )
            : commitCommand(input),
        );
      const send = (id: CommandId) =>
        threads.sendToThread({
          commandId: id,
          projectId,
          threadId,
          messageId: MessageId.make(`message:${id}`),
          text: "Do the work",
          attachments: [],
          mode: "queue",
          createdBy: entry === "manual" ? "user" : "agent",
          creationSource: entry === "manual" ? "web" : entry === "mcp" ? "mcp" : "server",
          ...(entry === "manual" || entry === "mcp"
            ? {}
            : { scheduledTaskId: ScheduledTaskId.make(`task:${entry}`) }),
        });
      const sending = yield* send(commandId).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.raceFirst(
        Deferred.await(beforeCommit),
        Fiber.join(sending).pipe(
          Effect.andThen(Effect.die("Message never reached the commit barrier")),
        ),
      );
      const acquiring = yield* Effect.flip(drain.execute({ operation: "acquire", leaseId })).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.equal((yield* drain.execute({ operation: "status" })).state, "acquiring");
      const refused = yield* Effect.flip(send(CommandId.make("refused")));
      assert.equal(refused._tag, "ServerDrainError");
      yield* Deferred.succeed(commitAllowed, undefined);
      yield* Fiber.join(sending);
      assert.equal((yield* Fiber.join(acquiring)).reason, "busy");
      assert.isTrue(
        (yield* outbox.listByCommandId(commandId)).some(
          (row) => row.request.type === "provider-turn.start",
        ),
      );
      assert.equal((yield* drain.execute({ operation: "status" })).state, "open");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a held lease blocks direct dispatch and queue resume but permits stop and cleanup", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const drain = yield* DeploymentDrain.DeploymentDrain;
    yield* createThread;
    assert.equal((yield* drain.execute({ operation: "acquire", leaseId })).state, "held");
    for (const command of [
      {
        type: "queue.resume" as const,
        commandId: CommandId.make("resume"),
        threadId,
        startNextDespitePause: true,
      },
      {
        type: "message.dispatch" as const,
        commandId: CommandId.make("direct"),
        threadId,
        messageId: MessageId.make("direct"),
        text: "Go",
        attachments: [],
        dispatchMode: { type: "start_immediately" as const },
        createdBy: "user" as const,
        creationSource: "web" as const,
      },
    ])
      assert.equal((yield* Effect.flip(orchestrator.dispatch(command)))._tag, "ServerDrainError");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop"),
      threadId,
    });
    assert.equal((yield* drain.execute({ operation: "cancel", leaseId })).state, "open");
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename"),
      threadId,
      title: "Open again",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["provider-turn.start", "provider-turn.restart"] as const)(
  "an already persisted %s remains busy before claim, during execution and during delayed retry",
  (type) =>
    Effect.gen(function* () {
      const executing = yield* Deferred.make<void>();
      const complete = yield* Deferred.make<void>();
      const layerWorker = EffectWorker.layer.pipe(
        Layer.provide(
          Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
            execute: () =>
              Deferred.succeed(executing, undefined).pipe(Effect.andThen(Deferred.await(complete))),
          }),
        ),
      );
      return yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const drain = yield* DeploymentDrain.DeploymentDrain;
        // Use the real worker/outbox with only its external executor replaced.
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const id = "effect:persisted";
        yield* outbox.enqueue([
          {
            id,
            commandId: CommandId.make("persisted"),
            threadId,
            request:
              type === "provider-turn.start"
                ? { type, runId: RunId.make("persisted") }
                : {
                    type,
                    runId: RunId.make("persisted"),
                    providerSessionId: ProviderSessionId.make("session"),
                    providerThreadId: ProviderThreadId.make("provider-thread"),
                    providerTurnId: ProviderTurnId.make("turn"),
                    interruptedAttemptId: RunAttemptId.make("attempt"),
                  },
          },
        ]);
        assert.equal(
          (yield* Effect.flip(drain.execute({ operation: "acquire", leaseId }))).reason,
          "busy",
        );
        const running = yield* worker.runOnce.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(executing);
        const acquiring = yield* drain
          .execute({ operation: "acquire", leaseId })
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.equal((yield* drain.execute({ operation: "status" })).state, "acquiring");
        yield* Deferred.succeed(complete, undefined);
        yield* Fiber.join(running);
        assert.equal((yield* Fiber.join(acquiring)).state, "held");
        yield* drain.execute({ operation: "cancel", leaseId });
        const row = yield* outbox.get(id);
        assert.isTrue(Option.isSome(row) && row.value.status === "succeeded");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'pending', available_at = '2999-01-01T00:00:00.000Z' WHERE effect_id = ${id}`;
        assert.isFalse(yield* worker.runOnce);
        assert.equal(
          (yield* Effect.flip(drain.execute({ operation: "acquire", leaseId }))).reason,
          "busy",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DeploymentDrain.layer,
            layerWorker.pipe(Layer.provide(EffectOutbox.layer)),
            EffectOutbox.layer,
          ).pipe(Layer.provide(layerIdleSessions), Layer.provideMerge(database)),
        ),
      );
    }),
);

it.effect("SQL inspection failure reopens and the server operation recovers on expiry", () =>
  Effect.gen(function* () {
    const drain = yield* DeploymentDrain.DeploymentDrain;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE orchestration_v2_effect_outbox RENAME TO drain_test_outbox`;
    assert.equal(
      (yield* Effect.flip(drain.execute({ operation: "acquire", leaseId }))).reason,
      "inspection_failed",
    );
    assert.equal((yield* drain.execute({ operation: "status" })).state, "open");
    yield* sql`ALTER TABLE drain_test_outbox RENAME TO orchestration_v2_effect_outbox`;
    yield* drain.execute({ operation: "acquire", leaseId });
    yield* TestClock.adjust("120 seconds");
    assert.equal((yield* drain.execute({ operation: "status" })).state, "open");
  }).pipe(
    Effect.provide(
      DeploymentDrain.layer.pipe(Layer.provide(layerIdleSessions), Layer.provideMerge(database)),
    ),
  ),
);

it.effect("a held lease leaves newly persisted starts unclaimed while cleanup can execute", () =>
  Effect.gen(function* () {
    const executed: string[] = [];
    const workerLayer = EffectWorker.layer.pipe(
      Layer.provide(
        Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
          execute: (row) =>
            Effect.sync(() => {
              executed.push(row.request.type);
            }),
        }),
      ),
      Layer.provide(EffectOutbox.layer),
    );
    yield* Effect.gen(function* () {
      const drain = yield* DeploymentDrain.DeploymentDrain;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* drain.execute({ operation: "acquire", leaseId });
      yield* outbox.enqueue([
        {
          id: "start-after-close",
          commandId: CommandId.make("late-start"),
          threadId,
          request: { type: "provider-turn.start", runId: RunId.make("late-start") },
        },
        {
          id: "cleanup-after-close",
          commandId: CommandId.make("cleanup"),
          threadId: ThreadId.make("cleanup-thread"),
          request: { type: "terminal.cleanup" },
        },
      ]);
      assert.equal(yield* worker.drain(), 1);
      assert.deepEqual(executed, ["terminal.cleanup"]);
      const start = yield* outbox.get("start-after-close");
      assert.isTrue(
        Option.isSome(start) && start.value.status === "pending" && start.value.attemptCount === 0,
      );
      yield* drain.execute({ operation: "cancel", leaseId });
      assert.equal(yield* worker.drain(), 1);
      assert.deepEqual(executed, ["terminal.cleanup", "provider-turn.start"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(DeploymentDrain.layer, workerLayer, EffectOutbox.layer).pipe(
          Layer.provide(layerIdleSessions),
          Layer.provide(database),
        ),
      ),
    );
  }),
);

it.effect(
  "pending durable cleanup retries can survive a deployment, but executing cleanup cannot",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const drain = yield* DeploymentDrain.DeploymentDrain;
      const sql = yield* SqlClient.SqlClient;
      yield* outbox.enqueue([
        {
          id: "cleanup",
          commandId: CommandId.make("cleanup"),
          threadId,
          request: { type: "terminal.cleanup" },
          availableAt: DateTime.makeUnsafe("2999-01-01T00:00:00.000Z"),
        },
      ]);
      assert.equal((yield* drain.execute({ operation: "acquire", leaseId })).state, "held");
      yield* drain.execute({ operation: "cancel", leaseId });
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running' WHERE effect_id = 'cleanup'`;
      assert.equal(
        (yield* Effect.flip(
          drain.execute({ operation: "acquire", leaseId, recoveryPolicy: "s97" }),
        )).reason,
        "busy",
      );
      assert.equal((yield* drain.execute({ operation: "status" })).state, "open");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(DeploymentDrain.layer, EffectOutbox.layer).pipe(
          Layer.provide(layerIdleSessions),
          Layer.provideMerge(database),
        ),
      ),
    ),
);

it.effect.each(["cancel", "expiry", "queue held", "queues paused"] as const)(
  "queue promotion remains closed and reopening respects %s",
  (mode) => {
    const queueRuntime = ProviderReplayHarness.layerWithRegistry(
      { name: `drain-queue-${mode}` },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: database,
        runEffectWorker: false,
        threadQueuesPaused: mode === "queues paused",
      },
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const drain = yield* DeploymentDrain.DeploymentDrain;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* createThread;
      for (const [id, type] of [
        ["prepare", "defer_start"],
        ["queued", "queue_after_active"],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(id),
          text: id,
          attachments: [],
          dispatchMode: { type },
          createdBy: "user",
          creationSource: "web",
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-preparing"),
        threadId,
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const queued = before.runs.find((run) => run.status === "queued")!;
      assert.isDefined(queued);
      assert.isTrue(queued.queueHeld);
      if (mode !== "queue held") {
        // Seed a deliverable queue without publishing an event that could
        // promote it before this test closes admission.
        yield* projections.apply({
          id: EventId.make("deliverable"),
          type: "run.updated",
          threadId,
          runId: queued.id,
          occurredAt: yield* DateTime.now,
          payload: { ...queued, queueHeld: false },
        });
      }
      assert.equal((yield* drain.execute({ operation: "acquire", leaseId })).state, "held");
      yield* orchestrator.resumeQueuedRuns;
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find((run) => run.id === queued.id)
          ?.status,
        "queued",
      );
      if (mode === "cancel" || mode === "expiry") {
        const started = yield* sink
          .stream({ threadId, afterSequence: yield* sink.latestSequence({ threadId }) })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === queued.id &&
                stored.event.payload.status === "starting",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
        if (mode === "expiry") yield* TestClock.adjust("120 seconds");
        else yield* drain.execute({ operation: "cancel", leaseId });
        yield* Fiber.join(started);
      } else {
        yield* drain.execute({ operation: "cancel", leaseId });
        yield* orchestrator.resumeQueuedRuns;
        const after = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === queued.id,
        )!;
        assert.equal(after.status, "queued");
        assert.equal(after.queueHeld, mode === "queue held");
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          queueRuntime,
          ProjectionStore.layer,
          DeploymentDrain.layer.pipe(Layer.provide(queueRuntime)),
        ).pipe(Layer.provide(database)),
      ),
    );
  },
);
