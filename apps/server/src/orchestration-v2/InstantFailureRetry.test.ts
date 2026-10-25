import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  TurnItemId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  instantFailureRetryCommand,
  isTransientStartFailure,
  selectionBeforeMove,
} from "./InstantFailureRetry.ts";
import * as InstantFailureRetry from "./InstantFailureRetry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorkAdmission from "./WorkAdmission.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

type Projection = Parameters<typeof instantFailureRetryCommand>[0];
type Run = OrchestrationV2ThreadProjection["runs"][number];
type Message = OrchestrationV2ThreadProjection["messages"][number];
type TurnItem = OrchestrationV2ThreadProjection["turnItems"][number];

const threadId = ThreadId.make("thread:retry");
const runId = RunId.make("run:1");
const instance = ProviderInstanceId.make("codex");
const at = (iso: string) => DateTime.makeUnsafe(iso);

// Only the fields the decision reads; the rest of the records do not matter here.
const run = (overrides: Partial<Run> = {}) =>
  ({
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instance,
    modelSelection: { instanceId: instance, model: "gpt-5.4" },
    userMessageId: MessageId.make("message:user"),
    status: "failed",
    requestedAt: at("2026-10-11T08:00:00.000Z"),
    startedAt: at("2026-10-11T08:00:01.000Z"),
    completedAt: at("2026-10-11T08:00:03.000Z"),
    ...overrides,
  }) as Run;

const userMessage = (overrides: Partial<Message> = {}) =>
  ({
    id: MessageId.make("message:user"),
    threadId,
    runId,
    role: "user",
    text: "Fix the build.",
    attachments: [],
    ...overrides,
  }) as Message;

const failure = (cls: string, message: string) =>
  ({ type: "error", runId, failure: { class: cls, message } }) as TurnItem;

const sessionDidNotOpen = failure(
  "provider_error",
  "Failed to open codex provider session provider-session:provider-instance:codex:shared.",
);

const projection = (overrides: Partial<Projection> = {}): Projection => ({
  thread: {
    id: threadId,
    archivedAt: null,
    deletedAt: null,
    providerInstanceId: instance,
  } as Projection["thread"],
  runs: [run()],
  messages: [userMessage()],
  turnItems: [sessionDidNotOpen],
  ...overrides,
});

it.effect.each(["cancel", "wrapped", "archived", "disabled"] as const)(
  "filters unrelated events while reconsidering an instant failure rejected during drain: %s",
  (scenario) => {
    const database = SqlitePersistence.layerMemory;
    const settings = ServerSettings.layerTest({ retryInstantFailures: true });
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: `instant-retry-drain-${scenario}` },
      ProviderAdapterRegistry.layerFromAdapters([
        {
          instanceId: instance,
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () => Effect.die("This test must not start a provider process"),
        } as ProviderAdapter.ProviderAdapterV2["Service"],
      ]),
      { databaseLayer: database, runEffectWorker: false },
    );
    const layerTest = Layer.mergeAll(
      runtime,
      settings,
      WorkAdmission.layer,
      ThreadManagement.layer.pipe(
        Layer.provide(Layer.mergeAll(runtime, CommandReceiptStore.layer, settings)),
      ),
    ).pipe(Layer.provide(database));
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const admission = yield* WorkAdmission.WorkAdmission;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:retry"),
        threadId,
        projectId: ProjectId.make("project:retry"),
        title: "Retry during drain",
        modelSelection: { instanceId: instance, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:retry"),
        threadId,
        messageId: MessageId.make("message:retry-start"),
        text: "Fix the build.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const original = yield* threads.getThreadProjection(threadId);
      const starting = original.runs[0]!;
      const watching = yield* Deferred.make<void>();
      const rejected = yield* Deferred.make<void>();
      const consumed = yield* Deferred.make<void>();
      const startupEntered = yield* Deferred.make<void>();
      const failStartup = yield* Deferred.make<void>();
      const dispatch = threads.dispatch;
      const attempts: CommandId[] = [];
      using _dispatch = vi.spyOn(threads, "dispatch").mockImplementation((command) =>
        Effect.sync(() => attempts.push(command.commandId)).pipe(
          Effect.andThen(dispatch(command)),
          Effect.tapError(() => Deferred.succeed(rejected, undefined)),
          Effect.mapError((cause) =>
            scenario === "wrapped"
              ? new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                })
              : cause,
          ),
        ),
      );
      const markerId = EventId.make("event:retry-marker");
      const observedEvents: EventId[] = [];
      const stream = sink.stream;
      using _stream = vi.spyOn(sink, "stream").mockImplementation((input) =>
        stream(input).pipe(
          Stream.onStart(Deferred.succeed(watching, undefined)),
          Stream.takeUntil((stored) => stored.event.id === markerId),
          Stream.tap((stored) =>
            Effect.sync(() => observedEvents.push(stored.event.id)).pipe(
              Effect.andThen(
                stored.event.id === markerId ? Deferred.succeed(consumed, undefined) : Effect.void,
              ),
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* Deferred.await(watching);
        const now = yield* DateTime.now;
        const failed = { ...starting, status: "failed" as const, completedAt: now };
        const errorItem = {
          id: TurnItemId.make("item:retry-error"),
          threadId,
          runId: starting.id,
          nodeId: starting.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          type: "error",
          status: "failed",
          title: "Could not start",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          failure: {
            class: "transport_error",
            message: "Provider disconnected",
            code: null,
            retryable: null,
          },
        } satisfies TurnItem;
        const failureCommit = sink.write({
          events: [
            {
              id: EventId.make("event:retry-error"),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: errorItem,
            },
            {
              id: EventId.make("event:retry-failed"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: failed,
            },
            {
              id: EventId.make("event:retry-failed-again"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: failed,
            },
          ],
        });
        const startup = yield* admission
          .run(
            Deferred.succeed(startupEntered, undefined).pipe(
              Effect.andThen(Deferred.await(failStartup)),
              Effect.andThen(failureCommit),
            ),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(startupEntered);
        const acquiring = yield* admission
          .acquire("retry-drain", Effect.void)
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect((yield* admission.status).state).toBe("acquiring");
        yield* Deferred.succeed(failStartup, undefined);
        yield* Fiber.join(startup);
        yield* Fiber.join(acquiring);
        yield* Deferred.await(rejected);
        expect(attempts).toHaveLength(1);
        if (scenario === "archived") {
          yield* sink.write({
            events: [
              {
                id: EventId.make("event:retry-archive"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: { ...original.thread, archivedAt: now },
              },
            ],
          });
        }
        if (scenario === "disabled")
          yield* serverSettings.updateSettings({ retryInstantFailures: false });
        yield* sink.write({
          events: [
            ...Array.from({ length: 8 }, (_, index) => ({
              id: EventId.make(`event:unrelated-item:${index}`),
              type: "turn-item.updated" as const,
              threadId,
              occurredAt: now,
              payload: { ...errorItem, title: `Unrelated update ${index}` },
            })),
            {
              id: markerId,
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: failed,
            },
          ],
        });
        yield* admission.cancel("retry-drain");
        yield* Deferred.await(consumed);
        const after = yield* threads.getThreadProjection(threadId);
        const shouldRetry = scenario === "cancel" || scenario === "wrapped";
        expect(
          after.messages.filter((message) => message.id.startsWith("message:instant-retry:")),
        ).toHaveLength(shouldRetry ? 1 : 0);
        expect(attempts).toHaveLength(shouldRetry ? 2 : 1);
        expect(observedEvents).toEqual([
          EventId.make("event:retry-failed"),
          EventId.make("event:retry-failed-again"),
          markerId,
        ]);
      }).pipe(Effect.provide(InstantFailureRetry.layer));
    }).pipe(Effect.provide(layerTest));
  },
);

describe("isTransientStartFailure", () => {
  it("accepts the start failures seen in practice", () => {
    expect(
      isTransientStartFailure({ class: "transport_error", message: "Provider turn failed." }),
    ).toBe(true);
    expect(
      isTransientStartFailure(
        sessionDidNotOpen.type === "error" ? sessionDidNotOpen.failure : never(),
      ),
    ).toBe(true);
    expect(
      isTransientStartFailure({
        class: "provider_error",
        message: "Codex App Server process exited with code 1",
      }),
    ).toBe(true);
  });

  it("rejects failures that would repeat", () => {
    expect(
      isTransientStartFailure({ class: "usage_limit", message: "Claude API rate limit reached." }),
    ).toBe(false);
    expect(
      isTransientStartFailure({
        class: "provider_error",
        message: "Insufficient context allowance for the provider handoff.",
      }),
    ).toBe(false);
    expect(isTransientStartFailure({ class: "permission_error", message: "Not signed in." })).toBe(
      false,
    );
  });
});

function never(): never {
  throw new Error("unreachable");
}

describe("instantFailureRetryCommand", () => {
  it("sends the same message again after a start failure", () => {
    const command = instantFailureRetryCommand(projection(), runId);
    expect(command).toMatchObject({
      type: "message.dispatch",
      threadId,
      text: "Fix the build.",
      messageId: "message:instant-retry:run:1",
      dispatchMode: { type: "queue_after_active" },
    });
  });

  it("retries once: a failed retry is reported", () => {
    const retryMessageId = MessageId.make("message:instant-retry:run:0");
    expect(
      instantFailureRetryCommand(
        projection({
          runs: [run({ userMessageId: retryMessageId })],
          messages: [userMessage({ id: retryMessageId })],
        }),
        runId,
      ),
    ).toBeNull();
  });

  it("leaves a turn alone that ran for a while or said something", () => {
    expect(
      instantFailureRetryCommand(
        projection({ runs: [run({ completedAt: at("2026-10-11T08:02:00.000Z") })] }),
        runId,
      ),
    ).toBeNull();
    expect(
      instantFailureRetryCommand(
        projection({
          messages: [
            userMessage(),
            userMessage({ id: MessageId.make("message:reply"), role: "assistant", text: "On it." }),
          ],
        }),
        runId,
      ),
    ).toBeNull();
  });

  it("does not retry a failure that would repeat", () => {
    expect(
      instantFailureRetryCommand(
        projection({ turnItems: [failure("usage_limit", "Claude API rate limit reached.")] }),
        runId,
      ),
    ).toBeNull();
    expect(instantFailureRetryCommand(projection({ turnItems: [] }), runId)).toBeNull();
  });

  it("steps aside when something newer ran in the thread", () => {
    const later = run({
      id: RunId.make("run:2"),
      ordinal: 2,
      status: "completed",
      completedAt: at("2026-10-11T08:00:30.000Z"),
    });
    expect(instantFailureRetryCommand(projection({ runs: [run(), later] }), runId)).toBeNull();
  });
});

describe("a turn that fails on the handoff after the thread was moved", () => {
  const other = ProviderInstanceId.make("codex_stark_cli");
  const before = run({
    id: RunId.make("run:0"),
    ordinal: 0,
    status: "completed",
    providerInstanceId: other,
    modelSelection: { instanceId: other, model: "gpt-6-astra" },
  });
  const handoff = failure(
    "provider_error",
    "Insufficient context allowance for the provider handoff. Compact the target conversation or use a larger-context model; the current request has not been truncated.",
  );
  const moved = projection({ runs: [before, run()], turnItems: [handoff] });

  it("finds the account the thread worked on before", () => {
    expect(selectionBeforeMove(moved.runs, runId)).toEqual({
      instanceId: other,
      model: "gpt-6-astra",
    });
    // Not moved: the run before was on the same account.
    expect(
      selectionBeforeMove(
        [run({ id: RunId.make("run:0"), ordinal: 0, status: "completed" }), run()],
        runId,
      ),
    ).toBeNull();
    expect(selectionBeforeMove([run()], runId)).toBeNull();
  });

  it("sends the turn again on that account", () => {
    const backTo = selectionBeforeMove(moved.runs, runId);
    const command = instantFailureRetryCommand(moved, runId, backTo);
    expect(command).toMatchObject({
      type: "message.dispatch",
      text: "Fix the build.",
      modelSelection: { instanceId: other, model: "gpt-6-astra" },
    });
  });

  it("does not retry the handoff failure without an account to go back to", () => {
    expect(instantFailureRetryCommand(moved, runId, null)).toBeNull();
    // A start failure of another kind still retries on the same account.
    const command = instantFailureRetryCommand(
      projection({ runs: [before, run()] }),
      runId,
      selectionBeforeMove(moved.runs, runId),
    );
    expect(command).toMatchObject({ modelSelection: { instanceId: instance, model: "gpt-5.4" } });
  });
});
