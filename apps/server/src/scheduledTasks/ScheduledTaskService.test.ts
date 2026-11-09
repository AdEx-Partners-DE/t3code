import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  SecretRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";

import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const isScheduledTaskError = Schema.is(ScheduledTaskError);

const threadShell = (
  projectId: ProjectId,
  state: { archivedAt?: string | null; deletedAt?: string | null } = {},
) => ({ projectId, archivedAt: null, deletedAt: null, ...state }) as never;

const insertRow = (
  sql: SqlClient.SqlClient,
  row: {
    id: string | null;
    next: string | null;
    enabled: number;
    status: string;
    scheduleJson?: string;
    prompt?: string;
  },
  now: string,
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: row.id,
    title: "task",
    prompt: row.prompt ?? "Run task",
    enabled: row.enabled,
    schedule_json: row.scheduleJson ?? '{"type":"interval","everyMs":60000}',
    project_id: "project:test",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    next_run_at: row.next,
    last_run_at: null,
    last_run_status: row.status,
    last_run_error: null,
    run_count: 0,
  })}`;

it.effect.each([
  ["interval", "pending"],
  ["interval", "running"],
  ["fixed_time", "pending"],
  ["fixed_time", "running"],
] as const)(
  "defers a bound %s catch-up while its restart continuation is %s",
  ([trigger, continuationStatus]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      const scheduleJson =
        trigger === "interval"
          ? '{"type":"interval","everyMs":60000}'
          : '{"type":"fixed_time","timeOfDay":"12:00"}';
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      for (const id of ["bound", "fresh"]) {
        yield* insertRow(
          sql,
          { id, next: now, enabled: 1, status: "succeeded", scheduleJson },
          now,
        );
      }
      yield* sql`UPDATE scheduled_tasks SET thread_id = 'thread:restart', run_count = 1
                 WHERE task_id = 'bound'`;
      yield* sql`INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        available_at, created_at, updated_at
      ) VALUES (
        'effect:restart-continuation:cut', 'command:restart', 'thread:restart',
        'provider-runtime.continue', '{"type":"provider-runtime.continue","sourceRunId":"cut"}',
        ${continuationStatus}, ${now}, ${now}, ${now}
      )`;
      const sends: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["sendToThread"]
      >[0][] = [];
      let launches = 0;
      let poll: Effect.Effect<void> | undefined;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            ScheduledTaskService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeCrypto.layer,
                  ManagedPolicy.layerTest(),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                    launch: () => {
                      launches += 1;
                      return Effect.succeed({} as never);
                    },
                  }),
                  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                    namedProjectsRoot: "/projects",
                    isScratchProject: () => Effect.succeed(false),
                  }),
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getProjectThreadRecords: () => Effect.succeed({ runs: [] } as never),
                    sendToThread: (input) => {
                      sends.push(input);
                      return Effect.succeed({} as never);
                    },
                  }),
                  Layer.succeed(Scheduler.Scheduler, {
                    // The fork registers a second poll for idle tasks; this test drives the timed one.
                    register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
                      Effect.context<R>().pipe(
                        Effect.map((context) => {
                          if (name !== "scheduled-tasks") return;
                          poll = work.pipe(Effect.provideContext(context), Effect.orDie);
                        }),
                      ),
                  }),
                ),
              ),
            ),
          );
          assert.isDefined(poll);
          yield* poll!;
          assert.lengthOf(sends, 0);
          assert.equal(launches, 1);
          const deferred = yield* sql<{ next_run_at: string; run_count: number }>`
            SELECT next_run_at, run_count FROM scheduled_tasks WHERE task_id = 'bound'
          `;
          assert.equal(deferred[0]?.next_run_at, now);
          assert.equal(deferred[0]?.run_count, 1);

          yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`;
          yield* poll!;
          assert.lengthOf(sends, 1);
          assert.equal(sends[0]?.threadId, "thread:restart");
          assert.equal(sends[0]?.mode, "queue");
          const completed = yield* sql<{
            next_run_at: string;
            run_count: number;
            last_run_status: string;
          }>`SELECT next_run_at, run_count, last_run_status FROM scheduled_tasks
             WHERE task_id = 'bound'`;
          assert.equal(completed[0]?.last_run_status, "succeeded");
          assert.equal(completed[0]?.run_count, 2);
          assert.isAbove(Date.parse(completed[0]!.next_run_at), Date.parse(now) + 1_000);
          yield* poll!;
          assert.lengthOf(sends, 1);
          assert.equal(launches, 1);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("loads only due tasks and skips corrupt due rows without decoding settled tasks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    const secret = "PROMPT-SECRET-DO-NOT-LOG";
    const credential = "CREDENTIAL-SECRET-DO-NOT-LOG";
    for (const row of [
      { id: "due-now", next: now, enabled: 1, status: "never" },
      { id: "", next: now, enabled: 1, status: "never" },
      { id: "   ", next: now, enabled: 1, status: "never" },
      { id: null, next: now, enabled: 1, status: "never" },
      {
        id: "due-earlier",
        next: "2026-09-09T11:00:00.000Z",
        enabled: 1,
        status: "failed",
      },
      { id: "due-bad-date", next: "", enabled: 1, status: "never" },
      {
        id: "due-corrupt",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "due-cred",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: `{"type":"interval","everyMs":"${credential}"}`,
      },
      { id: "disabled", next: now, enabled: 0, status: "never", scheduleJson: "broken" },
      {
        id: "future",
        next: "2026-09-09T12:00:00.001Z",
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "unscheduled",
        next: null,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      { id: "running", next: now, enabled: 1, status: "running", scheduleJson: "broken" },
    ]) {
      yield* insertRow(sql, { ...row, prompt: secret }, now);
    }
    const warnings: unknown[] = [];
    const tasks = yield* ScheduledTaskService.listDueTasks(DateTime.makeUnsafe(now)).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            warnings.push(message);
          }),
        ]),
      ),
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      ["due-earlier", "due-now"],
    );
    assert.equal(warnings.length, 6);
    const annotations = warnings.map(
      (warning) => (warning as ReadonlyArray<unknown>)[1] as Record<string, unknown>,
    );
    assert.deepEqual(
      annotations.map((annotation) => annotation.taskId),
      ["due-bad-date", null, "", "   ", "due-corrupt", "due-cred"],
    );
    const causes = annotations.map((annotation) => annotation.cause);
    assert.deepEqual(
      causes.map((cause) => (isScheduledTaskError(cause) ? cause.taskId : undefined)),
      [undefined, undefined, undefined, undefined, "due-corrupt", "due-cred"],
    );
    for (const cause of causes) {
      if (cause !== undefined) assert.isTrue(isScheduledTaskError(cause));
    }
    const rendered = NodeUtil.inspect(annotations, { depth: null });
    assert.isFalse(rendered.includes(secret));
    assert.isFalse(rendered.includes(credential));
    const running = yield* sql<{
      last_run_status: string;
    }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'running'`;
    assert.equal(running[0]?.last_run_status, "running");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "releases interrupted runs on startup and still executes due tasks, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      const hugeInterval = '{"type":"interval","everyMs":9000000000000000}';
      for (const row of [
        { id: "stuck-valid", next: now, status: "running" },
        {
          id: "stuck-fixed",
          next: now,
          status: "running",
          scheduleJson: '{"type":"fixed_time","timeOfDay":"12:00"}',
        },
        {
          id: "stuck-webhook",
          next: null,
          status: "running",
          scheduleJson: '{"type":"webhook","signature":null}',
        },
        { id: "stuck-corrupt", next: now, status: "running", scheduleJson: "broken" },
        { id: "stuck-huge", next: now, status: "running", scheduleJson: hugeInterval },
        { id: null, next: now, status: "running" },
        { id: "due-bad-date", next: "", status: "never" },
        { id: "due-healthy", next: now, status: "never" },
        { id: "due-huge", next: now, status: "never", scheduleJson: hugeInterval },
        { id: "due-second", next: now, status: "never" },
        { id: "due-third", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }

      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                ManagedPolicy.layerTest(),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 4
                          ? Deferred.succeed(lastDispatched, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseLast)),
                            )
                          : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          // The poll delays before its first pass; advance the frozen clock once.
          yield* TestClock.adjust("6 seconds");
          // Four tasks due at once are a pile and start one at a time with a
          // gap, so the clock is moved on until the fourth has gone out.
          yield* TestClock.adjust("25 seconds").pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.forever,
            Effect.forkScoped,
          );
          yield* Deferred.await(lastDispatched);
          const inflight = yield* sql<{
            last_run_status: string;
          }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'due-third'`;
          assert.equal(inflight[0]?.last_run_status, "running");
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );

      const rows = yield* sql<{
        task_id: string | null;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`SELECT task_id, last_run_status, last_run_error, next_run_at, run_count
       FROM scheduled_tasks ORDER BY task_id`;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      assert.equal(rows.length, 11);
      // The decodable stuck run is rescheduled for its next occurrence; the
      // undecodable and unrepresentable rows are released without a next run.
      // A NULL id must still match its own row — `= NULL` never does.
      assert.equal(byId.get("stuck-valid")?.last_run_status, "failed");
      assert.isNotNull(byId.get("stuck-valid")?.next_run_at);
      assert.isAbove(Date.parse(byId.get("stuck-fixed")!.next_run_at!), Date.parse(now) + 7_000);
      assert.isNull(byId.get("stuck-webhook")?.next_run_at);
      assert.equal(byId.get("stuck-corrupt")?.last_run_status, "failed");
      assert.equal(byId.get(null)?.last_run_status, "failed");
      const stuckHuge = byId.get("stuck-huge");
      assert.equal(stuckHuge?.last_run_status, "failed");
      assert.isNull(stuckHuge?.next_run_at);
      for (const id of [
        "stuck-valid",
        "stuck-fixed",
        "stuck-webhook",
        "stuck-corrupt",
        "stuck-huge",
        null,
      ]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.equal(row?.last_run_error, "Run was interrupted by a server restart.");
        assert.equal(row?.run_count, 1);
      }
      for (const id of ["due-healthy", "due-huge", "due-second"]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.isTrue(row?.last_run_error?.includes("test launch failure") === true);
        assert.equal(row?.run_count, 1);
      }
      assert.isNull(byId.get("due-huge")?.next_run_at);
      assert.equal(byId.get("due-bad-date")?.last_run_status, "never");
      assert.equal(byId.get("due-bad-date")?.run_count, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "treats a next_run_at corrupted before the dispatch re-read as not due instead of defecting the poll",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      for (const row of [
        { id: "run-a", next: now, status: "never" },
        { id: "run-b-victim", next: now, status: "never" },
        { id: "run-c", next: now, status: "never" },
        { id: "run-d", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                ManagedPolicy.layerTest(),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 1
                          ? sql`UPDATE scheduled_tasks
                                SET next_run_at = ''
                                WHERE task_id = 'run-b-victim'`.pipe(Effect.asVoid, Effect.orDie)
                          : n === 3
                            ? Deferred.succeed(lastDispatched, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseLast)),
                              )
                            : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          assert.equal(yield* Ref.get(dispatched), 3);
          const rows = yield* sql<{
            task_id: string;
            last_run_status: string;
            next_run_at: string | null;
            run_count: number;
          }>`SELECT task_id, last_run_status, next_run_at, run_count
             FROM scheduled_tasks ORDER BY task_id`;
          const byId = new Map(rows.map((row) => [row.task_id, row]));
          const victim = byId.get("run-b-victim");
          assert.equal(victim?.last_run_status, "never");
          assert.equal(victim?.run_count, 0);
          assert.equal(victim?.next_run_at, "");
          for (const id of ["run-a", "run-c"]) {
            const row = byId.get(id);
            assert.equal(row?.last_run_status, "failed");
            assert.equal(row?.run_count, 1);
          }
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("holds every due task while scheduled tasks are paused, and runs them once resumed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    yield* insertRow(sql, { id: "due", next: now, status: "never", enabled: 1 }, now);
    yield* TestClock.setTime(Date.parse(now) + 1_000);

    const dispatched = yield* Ref.make(0);
    const launched = yield* Deferred.make<void>();
    const serviceWith = (paused: boolean) =>
      Layer.provideMerge(
        ScheduledTaskService.layer,
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(dispatched, (n) => n + 1).pipe(
                Effect.andThen(Deferred.succeed(launched, undefined)),
                Effect.andThen(Effect.die(new Error("test launch failure"))),
              ),
          }),
          ManagedPolicy.layerTest(),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          ServerSettings.layerTest({ scheduledTasksPaused: paused }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      );

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(serviceWith(true));
        // Two polls pass; a paused environment dispatches nothing in either.
        yield* TestClock.adjust("6 seconds");
        yield* TestClock.adjust("6 seconds");
        assert.equal(yield* Ref.get(dispatched), 0);
        const rows = yield* sql<{ run_count: number; last_run_status: string }>`
          SELECT run_count, last_run_status FROM scheduled_tasks WHERE task_id = 'due'
        `;
        assert.equal(rows[0]?.run_count, 0);
        assert.equal(rows[0]?.last_run_status, "never");
      }),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(serviceWith(false));
        yield* TestClock.adjust("6 seconds");
        yield* Deferred.await(launched);
        assert.equal(yield* Ref.get(dispatched), 1);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("runs a task that was switched on again by itself while all tasks are paused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    yield* insertRow(sql, { id: "stays-paused", next: now, status: "never", enabled: 1 }, now);
    yield* insertRow(sql, { id: "resumed", next: now, status: "never", enabled: 1 }, now);
    yield* TestClock.setTime(Date.parse(now) + 1_000);

    const launched = yield* Deferred.make<void>();
    const layer = Layer.provideMerge(
      ScheduledTaskService.layer,
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: () =>
            Deferred.succeed(launched, undefined).pipe(
              Effect.andThen(Effect.die(new Error("test launch failure"))),
            ),
        }),
        ManagedPolicy.layerTest(),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        ServerSettings.layerTest({ scheduledTasksPaused: true }),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const runCounts = sql<{ task_id: string; run_count: number }>`
        SELECT task_id, run_count FROM scheduled_tasks ORDER BY task_id
      `.pipe(Effect.map((rows) => rows.map((row) => [row.task_id, row.run_count])));
      yield* TestClock.adjust("6 seconds");
      assert.deepEqual(yield* runCounts, [
        ["resumed", 0],
        ["stays-paused", 0],
      ]);

      // The task is enabled already; its switch reads off because of the pause.
      // Switching it on is the user resuming this one task.
      yield* service.setEnabled({ id: "resumed" as never, enabled: true });
      assert.deepEqual((yield* settings.getSettings).scheduledTasksPauseExemptIds, ["resumed"]);
      yield* TestClock.adjust("6 seconds");
      yield* Deferred.await(launched);
      assert.deepEqual(yield* runCounts, [
        ["resumed", 1],
        ["stays-paused", 0],
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps an archived task off and out of the scheduler until it is restored", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    yield* insertRow(sql, { id: "first", next: now, status: "never", enabled: 1 }, now);
    yield* insertRow(sql, { id: "second", next: now, status: "never", enabled: 1 }, now);
    yield* insertRow(sql, { id: "third", next: null, status: "never", enabled: 0 }, now);
    yield* TestClock.setTime(Date.parse(now) + 1_000);

    const layer = Layer.provideMerge(
      ScheduledTaskService.layer,
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        ManagedPolicy.layerTest(),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const archivedIds = service
        .list()
        .pipe(
          Effect.map(({ tasks }) =>
            tasks.flatMap((task) => (task.archivedAt === undefined ? [] : [task.id as string])),
          ),
        );

      // Archived together, as the bulk action can: neither write may lose the other.
      yield* Effect.forEach(
        ["first", "second", "third"],
        (id) => service.setArchived({ id: id as never, archived: true }),
        { concurrency: "unbounded", discard: true },
      );
      assert.deepEqual((yield* archivedIds).toSorted(), ["first", "second", "third"]);
      const { tasks } = yield* service.list();
      assert.isTrue(tasks.every((task) => !task.enabled && task.nextRunAt === null));

      yield* TestClock.adjust("6 seconds");
      const ran = yield* sql<{ run_count: number }>`SELECT run_count FROM scheduled_tasks`;
      assert.isTrue(ran.every((row) => row.run_count === 0));

      // Restoring brings it back off; only an explicit switch-on runs it.
      yield* service.setArchived({ id: "first" as never, archived: false });
      assert.deepEqual((yield* archivedIds).toSorted(), ["second", "third"]);
      assert.isFalse((yield* service.list()).tasks.find((task) => task.id === "first")?.enabled);

      // A hidden task must not run, so switching one on takes it out of the archive.
      yield* service.setEnabled({ id: "second" as never, enabled: true });
      assert.deepEqual(yield* archivedIds, ["third"]);

      yield* service.delete({ id: "third" as never });
      assert.deepEqual((yield* settings.getSettings).scheduledTasksArchived, []);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("does not queue another prompt while the task's last one still waits in its thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    yield* insertRow(sql, { id: "bound", next: now, status: "never", enabled: 1 }, now);
    yield* sql`UPDATE scheduled_tasks SET thread_id = 'thread:test' WHERE task_id = 'bound'`;
    yield* TestClock.setTime(Date.parse(now) + 1_000);

    const sent = yield* Ref.make(0);
    const delivered = yield* Deferred.make<void>();
    const serviceWith = (pendingMessageId: string | null, readFails = false) =>
      Layer.provideMerge(
        ScheduledTaskService.layer,
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          ManagedPolicy.layerTest(),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getProjectThreadRecords: (() =>
              readFails
                ? Effect.fail({ _tag: "ThreadRecordsUnavailable" as const })
                : Effect.succeed({
                    runs:
                      pendingMessageId === null
                        ? []
                        : [{ status: "queued", userMessageId: pendingMessageId }],
                  })) as never,
            sendToThread: () =>
              Ref.update(sent, (n) => n + 1).pipe(
                Effect.andThen(Deferred.succeed(delivered, undefined)),
                Effect.andThen(Effect.die(new Error("test send failure"))),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      );

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(serviceWith("scheduled-task-message:bound:1:scheduled"));
        yield* TestClock.adjust("6 seconds");
        assert.equal(yield* Ref.get(sent), 0);
        const rows = yield* sql<{ run_count: number; next_run_at: string | null }>`
            SELECT run_count, next_run_at FROM scheduled_tasks WHERE task_id = 'bound'
          `;
        // Skipped, not run: nothing counted, and the next tick is a full interval away.
        assert.equal(rows[0]?.run_count, 0);
        assert.isTrue((rows[0]?.next_run_at ?? "") > now);
      }),
    );

    // A failed records read must defer the timer without admitting another prompt.
    yield* sql`UPDATE scheduled_tasks SET next_run_at = ${now} WHERE task_id = 'bound'`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(serviceWith(null, true));
        yield* TestClock.adjust("6 seconds");
        assert.equal(yield* Ref.get(sent), 0);
        const rows = yield* sql<{ run_count: number; next_run_at: string | null }>`
          SELECT run_count, next_run_at FROM scheduled_tasks WHERE task_id = 'bound'
        `;
        assert.equal(rows[0]?.run_count, 0);
        assert.isTrue((rows[0]?.next_run_at ?? "") > now);
      }),
    );

    // Another task's prompt in the same thread does not hold this one back.
    yield* sql`UPDATE scheduled_tasks SET next_run_at = ${now} WHERE task_id = 'bound'`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(serviceWith("scheduled-task-message:other:1:scheduled"));
        yield* TestClock.adjust("6 seconds");
        yield* Deferred.await(delivered);
        assert.equal(yield* Ref.get(sent), 1);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

// The idle poll reads the watched thread, the last reply and the account's
// headroom before it sends. One harness, three ways a task ends instead.
const idleHarness = (input: {
  readonly schedule: Record<string, unknown>;
  readonly lastReply: string;
  readonly usedPercent?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const armed = "2026-09-09T11:00:00.000Z";
    const now = "2026-09-09T12:00:00.000Z";
    yield* insertRow(
      sql,
      {
        id: "idle",
        next: null,
        status: "never",
        enabled: 1,
        scheduleJson: JSON.stringify({
          type: "idle",
          maxRuns: 3,
          minPauseMs: 0,
          ...input.schedule,
        }),
      },
      armed,
    );
    yield* sql`UPDATE scheduled_tasks SET thread_id = 'thread:own' WHERE task_id = 'idle'`;
    yield* TestClock.setTime(Date.parse(now));

    const sent = yield* Ref.make(0);
    const shellsRead = yield* Ref.make<ReadonlyArray<string>>([]);
    const sentModel = yield* Ref.make<unknown>("unset");
    const delivered = yield* Deferred.make<void>();
    const layer = Layer.provideMerge(
      ScheduledTaskService.layer,
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: ((threadId: string) =>
            Ref.update(shellsRead, (ids) => [...ids, threadId]).pipe(
              Effect.as({
                id: threadId,
                activeRunId: null,
                activityRunStatus: null,
                pendingRuntimeRequest: null,
                latestRunId: "run:1",
                // Finished after the task was armed, so the thread counts as idle.
                latestRunCompletedAt: DateTime.makeUnsafe("2026-09-09T11:30:00.000Z"),
                modelSelection: { instanceId: "codex", model: "gpt-5" },
              }),
            )) as never,
          getThreadRecords: (() =>
            Effect.succeed({
              messages: [{ role: "assistant", text: input.lastReply, runId: "run:1" }],
            })) as never,
          getProjectThreadRecords: (() => Effect.succeed({ runs: [] })) as never,
          sendToThread: ((sendInput: { readonly modelSelection?: unknown }) =>
            Ref.update(sent, (n) => n + 1).pipe(
              Effect.andThen(Ref.set(sentModel, sendInput.modelSelection ?? null)),
              Effect.andThen(Deferred.succeed(delivered, undefined)),
              Effect.andThen(Effect.die(new Error("test send failure"))),
            )) as never,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(
            input.usedPercent === undefined
              ? []
              : [
                  {
                    instanceId: "codex",
                    usageLimits: {
                      windows: [
                        {
                          id: "weekly",
                          kind: "weekly",
                          label: "Weekly",
                          usedPercent: input.usedPercent,
                        },
                      ],
                    },
                  },
                ],
          ) as never,
        }),
        ManagedPolicy.layerTest(),
        Layer.mock(SecretRequests.SecretRequests)({}),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    );
    const row = sql<{ enabled: number; last_run_error: string | null }>`
      SELECT enabled, last_run_error FROM scheduled_tasks WHERE task_id = 'idle'
    `.pipe(Effect.map((rows) => rows[0]!));
    return { layer, sent, sentModel, shellsRead, delivered, row };
  });

it.effect(
  "turns an idle task off instead of sending when the last reply holds its stop phrase",
  () =>
    Effect.gen(function* () {
      const harness = yield* idleHarness({
        schedule: { stopPhrase: "ALL DONE" },
        lastReply: "Nothing is left. All done.",
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(harness.layer);
          yield* TestClock.adjust("6 seconds");
          assert.equal(yield* Ref.get(harness.sent), 0);
          assert.equal((yield* harness.row).enabled, 0);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("sends an idle task's prompt when the reply does not hold the stop phrase", () =>
  Effect.gen(function* () {
    const harness = yield* idleHarness({
      schedule: { stopPhrase: "ALL DONE" },
      lastReply: "Two items are still open.",
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(harness.layer);
        yield* TestClock.adjust("6 seconds");
        yield* Deferred.await(harness.delivered);
        assert.equal(yield* Ref.get(harness.sent), 1);
        // Sent without a model: the thread keeps the one it runs on.
        assert.isNull(yield* Ref.get(harness.sentModel));
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("turns an idle task off at its usage budget and says why", () =>
  Effect.gen(function* () {
    const harness = yield* idleHarness({
      schedule: { minRemainingPercent: 20 },
      lastReply: "Carry on.",
      usedPercent: 90,
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(harness.layer);
        yield* TestClock.adjust("6 seconds");
        const row = yield* harness.row;
        assert.equal(yield* Ref.get(harness.sent), 0);
        assert.equal(row.enabled, 0);
        assert.include(row.last_run_error ?? "", "10% left");
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("judges idleness by the thread an idle task watches, not the one it posts to", () =>
  Effect.gen(function* () {
    const harness = yield* idleHarness({
      schedule: { watchThreadId: "thread:watched" },
      lastReply: "Finished.",
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(harness.layer);
        yield* TestClock.adjust("6 seconds");
        yield* Deferred.await(harness.delivered);
        assert.include(yield* Ref.get(harness.shellsRead), "thread:watched");
        assert.notInclude(yield* Ref.get(harness.shellsRead), "thread:own");
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("turns an idle task off at the stop phrase without waiting out its pause", () =>
  Effect.gen(function* () {
    const harness = yield* idleHarness({
      // The thread finished half an hour ago; the pause would run for hours yet.
      schedule: { stopPhrase: "ALL DONE", minPauseMs: 6 * 60 * 60_000 },
      lastReply: "All done.",
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(harness.layer);
        yield* TestClock.adjust("6 seconds");
        assert.equal(yield* Ref.get(harness.sent), 0);
        assert.equal((yield* harness.row).enabled, 0);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

// A portfolio task has no thread of its own: each poll it picks among all open
// threads. Three threads here: one holding the stop phrase, one to go on, one
// at work.
it.effect("a portfolio task sends to standing open threads only, once per finished run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertRow(
      sql,
      {
        id: "portfolio",
        next: null,
        status: "never",
        enabled: 1,
        scheduleJson: JSON.stringify({
          type: "idle",
          maxRuns: 5,
          minPauseMs: 0,
          allOpenThreads: true,
          maxParallel: 3,
          stopPhrase: "ALL DONE",
        }),
      },
      "2026-09-09T11:00:00.000Z",
    );
    yield* TestClock.setTime(Date.parse("2026-09-09T12:00:00.000Z"));

    const shellThread = (id: string, finishedAt: string, overrides: object = {}) => ({
      id,
      projectId: "project:one",
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      lineage: { relationshipToParent: null },
      activeRunId: null,
      activityRunStatus: null,
      pendingRuntimeRequest: null,
      status: "completed",
      snoozedUntil: null,
      latestRunId: `run:${id}`,
      latestRunCompletedAt: DateTime.makeUnsafe(finishedAt),
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      ...overrides,
    });
    const sent = yield* Ref.make<ReadonlyArray<{ threadId: string; model: unknown }>>([]);
    const layer = Layer.provideMerge(
      ScheduledTaskService.layer,
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        ManagedPolicy.layerTest(),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: (() =>
            Effect.succeed({
              threads: [
                shellThread("thread:stop", "2026-09-09T11:50:00.000Z"),
                shellThread("thread:go", "2026-09-09T11:40:00.000Z"),
                shellThread("thread:busy", "2026-09-09T11:30:00.000Z", {
                  activeRunId: "run:busy:2",
                }),
              ],
            })) as never,
          getThreadRecords: ((threadId: string) =>
            Effect.succeed({
              messages: [
                {
                  role: "assistant",
                  text: threadId === "thread:stop" ? "All done." : "Two items are open.",
                },
              ],
            })) as never,
          getProjectThreadRecords: (() => Effect.succeed({ runs: [] })) as never,
          sendToThread: ((input: { threadId: string; modelSelection?: unknown }) =>
            Ref.update(sent, (all) => [
              ...all,
              { threadId: input.threadId, model: input.modelSelection ?? null },
            ]).pipe(Effect.as({}))) as never,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]) as never,
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(layer);
        // Several polls: the second and later ones must not send again.
        yield* TestClock.adjust("30 seconds");
        // Sent without a model: the thread keeps the one it runs on.
        assert.deepEqual(yield* Ref.get(sent), [{ threadId: "thread:go", model: null }]);
        const rows = yield* sql<{ schedule_json: string; enabled: number }>`
          SELECT schedule_json, enabled FROM scheduled_tasks WHERE task_id = 'portfolio'
        `;
        const stored = JSON.parse(rows[0]!.schedule_json);
        assert.equal(stored.runsUsed, 1);
        assert.deepEqual(stored.nudged, {
          "thread:stop": "run:thread:stop",
          "thread:go": "run:thread:go",
        });
        assert.equal(rows[0]!.enabled, 1);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a portfolio task limited to its project leaves other projects' threads alone", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertRow(
      sql,
      {
        id: "portfolio",
        next: null,
        status: "never",
        enabled: 1,
        scheduleJson: JSON.stringify({
          type: "idle",
          maxRuns: 5,
          minPauseMs: 0,
          allOpenThreads: true,
          projectOnly: true,
          maxParallel: 3,
          stopPhrase: "ALL DONE",
        }),
      },
      "2026-09-09T11:00:00.000Z",
    );
    yield* TestClock.setTime(Date.parse("2026-09-09T12:00:00.000Z"));

    const shellThread = (id: string, finishedAt: string, overrides: object = {}) => ({
      id,
      projectId: "project:test",
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      lineage: { relationshipToParent: null },
      activeRunId: null,
      activityRunStatus: null,
      pendingRuntimeRequest: null,
      status: "completed",
      snoozedUntil: null,
      latestRunId: `run:${id}`,
      latestRunCompletedAt: DateTime.makeUnsafe(finishedAt),
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      ...overrides,
    });
    const sent = yield* Ref.make<ReadonlyArray<{ threadId: string; model: unknown }>>([]);
    const layer = Layer.provideMerge(
      ScheduledTaskService.layer,
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        ManagedPolicy.layerTest(),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: (() =>
            Effect.succeed({
              threads: [
                shellThread("thread:stop", "2026-09-09T11:50:00.000Z"),
                shellThread("thread:go", "2026-09-09T11:40:00.000Z", {
                  projectId: "project:other",
                }),
                shellThread("thread:busy", "2026-09-09T11:30:00.000Z", {
                  activeRunId: "run:busy:2",
                }),
              ],
            })) as never,
          getThreadRecords: ((threadId: string) =>
            Effect.succeed({
              messages: [
                {
                  role: "assistant",
                  text: threadId === "thread:stop" ? "All done." : "Two items are open.",
                },
              ],
            })) as never,
          getProjectThreadRecords: (() => Effect.succeed({ runs: [] })) as never,
          sendToThread: ((input: { threadId: string; modelSelection?: unknown }) =>
            Ref.update(sent, (all) => [
              ...all,
              { threadId: input.threadId, model: input.modelSelection ?? null },
            ]).pipe(Effect.as({}))) as never,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]) as never,
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(layer);
        // Several polls: the second and later ones must not send again.
        yield* TestClock.adjust("30 seconds");
        // Sent without a model: the thread keeps the one it runs on.
        assert.deepEqual(yield* Ref.get(sent), []);
        const rows = yield* sql<{ schedule_json: string; enabled: number }>`
          SELECT schedule_json, enabled FROM scheduled_tasks WHERE task_id = 'portfolio'
        `;
        assert.deepEqual(JSON.parse(rows[0]!.schedule_json).nudged, {
          "thread:stop": "run:thread:stop",
        });
        assert.equal(rows[0]!.enabled, 1);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("thread cleanup notifies subscribers and a finishing run cannot recreate the task", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const subscribed = yield* Deferred.make<void>();
    const running = yield* Deferred.make<void>();
    const removed = yield* Deferred.make<void>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die("test dispatch failure")),
              ),
            getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:deleted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:deleted-during-run"),
        title: "Check orchestration",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.subscribeList().pipe(
        Stream.runForEach(({ tasks }) => {
          const current = tasks.find((candidate) => candidate.id === task.id);
          if (current === undefined) return Deferred.succeed(removed, undefined);
          return current.lastRunStatus === "running"
            ? Deferred.succeed(running, undefined)
            : Deferred.succeed(subscribed, undefined);
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const run = yield* service.runNow({ id: task.id }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.await(running);
      const refused = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
      assert.equal(refused.message, "Schedule task is already running.");
      yield* service.deleteForThread(threadId);
      yield* Deferred.await(removed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(run);
      assert.lengthOf((yield* service.list()).tasks, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a bound run follows its thread when promotion moves it mid-send", () =>
  Effect.gen(function* () {
    const scratch = ProjectId.make("project:scratch");
    const promoted = ProjectId.make("project:promoted");
    const sends = yield* Ref.make<Array<{ projectId: ProjectId; commandId: string }>>([]);
    // Saving reads it first. Then the rebind lands, and the promotion commits between the shell
    // read and the retry.
    const shellProjects = yield* Ref.make([promoted, scratch, promoted]);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) =>
              Ref.updateAndGet(sends, (all) => [
                ...all,
                { projectId: input.projectId, commandId: input.commandId },
              ]).pipe(
                Effect.flatMap((all) =>
                  all.length < 3
                    ? Effect.fail(
                        new ThreadManagementService.ThreadManagementThreadNotFoundError({
                          projectId: input.projectId,
                          threadId: input.threadId,
                        }),
                      )
                    : Effect.succeed({} as never),
                ),
              ),
            getThreadShell: () =>
              Ref.modify(shellProjects, ([next, ...rest]) => [threadShell(next ?? promoted), rest]),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:promoted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:promoted-during-run"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: promoted,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      const result = yield* service.runNow({ id: task.id });

      assert.equal(result.threadId, threadId);
      const attempts = yield* Ref.get(sends);
      assert.deepEqual(
        attempts.map((attempt) => attempt.projectId),
        [promoted, scratch, promoted],
      );
      assert.equal(new Set(attempts.map((attempt) => attempt.commandId)).size, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a fresh-session task launches one thread, then starts each later run fresh in it", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const sends = yield* Ref.make<Array<{ threadId: ThreadId; freshContext?: boolean }>>([]);
    const launched = ThreadId.make("thread:fresh-session-task");
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launches, (n) => n + 1).pipe(
                Effect.as({ threadId: launched, resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed({ deletedAt: null } as never),
            sendToThread: (input) =>
              Ref.update(sends, (all) => [
                ...all,
                {
                  threadId: input.threadId,
                  ...(input.freshContext === undefined ? {} : { freshContext: input.freshContext }),
                },
              ]).pipe(Effect.as({} as never)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = {
        id: ScheduledTaskId.make("task:fresh-session"),
        title: "Triage",
        prompt: "Triage new issues",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      yield* service.upsert({ ...input, threadMode: "fresh_session" });

      assert.equal((yield* service.runNow({ id: input.id })).threadId, launched);
      // A form opened before the first run saves no thread; the binding stays.
      const { task } = yield* service.upsert({
        ...input,
        threadId: null,
        threadMode: "fresh_session",
      });
      assert.equal(task.threadId, launched);
      assert.equal(task.threadMode, "fresh_session");
      // A client that predates thread modes sends neither; both stay.
      const legacy = yield* service.upsert({ ...input, threadId: null });
      assert.equal(legacy.task.threadId, launched);
      assert.equal(legacy.task.threadMode, "fresh_session");
      yield* service.runNow({ id: input.id });

      assert.equal(yield* Ref.get(launches), 1);
      assert.deepEqual(yield* Ref.get(sends), [{ threadId: launched, freshContext: true }]);
      // Its thread stays in the old project, so moving the task leaves it for a new one.
      const moved = yield* service.upsert({
        ...input,
        projectId: ProjectId.make("project:moved"),
        threadId: launched,
      });
      assert.equal(moved.task.threadId, null);
      assert.equal(moved.task.threadMode, "fresh_session");
      const unbound = yield* service.upsert({ ...input, threadMode: "new_thread" });
      assert.equal(unbound.task.threadId, null);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a first run whose thread was deleted before it bound removes the task", () =>
  Effect.gen(function* () {
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread:deleted"),
                resumed: false,
              } as never),
          }),
          // Deleted before the binding landed, so its cleanup found no task to remove.
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ deletedAt: DateTime.makeUnsafe("2026-11-03T00:00:00Z") } as never),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:thread-deleted-mid-launch"),
        title: "Triage",
        prompt: "Triage new issues",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadMode: "continue",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.runNow({ id: task.id });
      assert.deepEqual((yield* service.list()).tasks, []);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["recreated under the same id", "moved to another project"] as const)(
  "a first run never binds its thread to a task %s",
  (change) =>
    Effect.gen(function* () {
      const launching = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const layer = ScheduledTaskService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ManagedPolicy.layerTest(),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: () =>
                Deferred.succeed(launching, undefined).pipe(
                  Effect.andThen(Deferred.await(proceed)),
                  Effect.as({
                    threadId: ThreadId.make("thread:old-generation"),
                    resumed: false,
                  } as never),
                ),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
              isScratchProject: () => Effect.succeed(false),
            }),
            NodeCrypto.layer,
            Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const input = {
          id: ScheduledTaskId.make("task:recreated-mid-launch"),
          title: "Triage",
          prompt: "Triage new issues",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project:test"),
          threadMode: "fresh_session",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        } as const;
        yield* service.upsert(input);
        const run = yield* Effect.forkChild(service.runNow({ id: input.id }));
        yield* Deferred.await(launching);
        if (change === "recreated under the same id") {
          yield* service.delete({ id: input.id });
          yield* TestClock.adjust("1 second");
          yield* service.upsert(input);
        } else {
          yield* service.upsert({ ...input, projectId: ProjectId.make("project:moved") });
        }
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.await(run);

        const replacement = (yield* service.list()).tasks.find((task) => task.id === input.id);
        assert.equal(replacement?.threadId, null);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("refuses saving an enabled task above the policy ceiling", () =>
  Effect.gen(function* () {
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest({
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { maxRuntimeMode: "auto-accept-edits" },
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const save = (enabled: boolean) =>
        service.upsert({
          id: ScheduledTaskId.make("task:above-ceiling"),
          title: "Nightly",
          prompt: "Check progress",
          enabled,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project:test"),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      const refused = yield* save(true).pipe(Effect.flip);
      assert.equal(refused.message, "Example Corp limits threads to Auto-accept edits.");
      assert.lengthOf((yield* service.list()).tasks, 0);
      // A disabled task does not run, so it can still be saved.
      yield* save(false);
      assert.lengthOf((yield* service.list()).tasks, 1);
      // Nor can it be switched back on while its mode is above the ceiling.
      const reenabled = yield* service
        .setEnabled({ id: ScheduledTaskId.make("task:above-ceiling"), enabled: true })
        .pipe(Effect.flip);
      assert.equal(reenabled.message, "Example Corp limits threads to Auto-accept edits.");
      // A task bound to a thread runs in that thread's mode, so its own is not checked.
      const bound = {
        id: ScheduledTaskId.make("task:bound"),
        title: "Follow up",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      yield* service.upsert({ ...bound, threadId: ThreadId.make("thread:bound") });
      // Nor when an edit omits the thread it stays bound to.
      yield* service.upsert(bound);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("checks a task's destination thread only when the destination changes", () =>
  Effect.gen(function* () {
    const project = ProjectId.make("project:test");
    const otherProject = ProjectId.make("project:other");
    const destination = ThreadId.make("thread:destination");
    const archivedAt = "2026-11-05T00:00:00.000Z";
    const shells = yield* Ref.make<ReadonlyMap<ThreadId, never>>(
      new Map([
        [destination, threadShell(project)],
        [ThreadId.make("thread:archived"), threadShell(project, { archivedAt })],
        [ThreadId.make("thread:deleted"), threadShell(project, { deletedAt: archivedAt })],
        [ThreadId.make("thread:other-project"), threadShell(otherProject)],
      ]),
    );
    const consumed = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Ref.get(shells).pipe(Effect.map((all) => all.get(threadId) ?? null)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({
            consume: () => Ref.update(consumed, (count) => count + 1).pipe(Effect.as("secret")),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const id = ScheduledTaskId.make("task:destination");
      const save = (
        threadId: ThreadId,
        schedule: ScheduledTaskUpsertInput["schedule"] = { type: "interval", everyMs: 60_000 },
      ) =>
        service.upsert({
          id,
          title: "Follow up",
          prompt: "Check progress",
          enabled: true,
          schedule,
          projectId: project,
          threadId,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });

      for (const [threadId, message] of [
        ["thread:missing", "That thread no longer exists."],
        ["thread:deleted", "That thread no longer exists."],
        ["thread:archived", "That thread is archived. Unarchive it or pick another destination."],
        ["thread:other-project", "That thread belongs to a different project."],
      ] as const) {
        const refused = yield* save(ThreadId.make(threadId)).pipe(Effect.flip);
        assert.equal(refused.message, message);
      }
      assert.lengthOf((yield* service.list()).tasks, 0);

      // A rejected save must not burn a one-shot secret.
      yield* save(ThreadId.make("thread:missing"), {
        type: "webhook",
        signature: {
          header: "x-signature",
          encoding: "hex",
          prefix: "",
          secretRef: SecretRef.make("secret-ref:00000000000000000000000000000001"),
        },
      }).pipe(Effect.flip);
      assert.equal(yield* Ref.get(consumed), 0);

      yield* save(destination);
      // A task whose thread was archived later stays editable.
      yield* Ref.update(shells, (all) =>
        new Map(all).set(destination, threadShell(project, { archivedAt })),
      );
      assert.equal((yield* save(destination)).task.threadId, destination);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a run interrupted right after it reserves the task does not block the next run", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launches, (n) => n + 1).pipe(
                Effect.as({ threadId: ThreadId.make("thread:launched"), resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:interrupted-reservation"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      // The reservation is the first Set.add of the task id; interrupt the run right there.
      const add = Set.prototype.add;
      let interrupted = false;
      const first = yield* Effect.gen(function* () {
        using _reserve = vi.spyOn(Set.prototype, "add").mockImplementation(function (
          this: Set<unknown>,
          value: unknown,
        ) {
          const result = add.call(this, value);
          if (value === task.id && !interrupted) {
            interrupted = true;
            Fiber.getCurrent()?.interruptUnsafe();
          }
          return result;
        });
        return yield* service
          .runNow({ id: task.id })
          .pipe(Effect.forkChild, Effect.flatMap(Fiber.await));
      });
      assert.isTrue(interrupted);
      assert.isTrue(Exit.hasInterrupts(first));

      const second = yield* service.runNow({ id: task.id });
      assert.equal(second.threadId, ThreadId.make("thread:launched"));
      assert.equal(yield* Ref.get(launches), 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
