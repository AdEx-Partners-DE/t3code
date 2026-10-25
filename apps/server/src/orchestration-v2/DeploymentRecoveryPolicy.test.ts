import { assert, it } from "@effect/vitest";
import { ProviderSessionId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DeploymentDrain from "./DeploymentDrain.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const leaseId = "bb379c6e-bede-41f2-8dd3-7977b0a41385";
const now = "2026-10-25T12:00:00.000Z";
const old = "2026-10-25T10:00:00.000Z";
const questionAt = "2026-10-25T10:59:00.000Z";
const fresh = "2026-10-25T11:59:00.000Z";
const layerTest = DeploymentDrain.layer.pipe(
  Layer.provide(
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ get: () => Effect.succeedNone }),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect.each([
  "idle",
  "buffered background",
  "old question with buffered background",
  "lookup failure",
] as const)("checks runtime activity: %s", (scenario) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (scenario === "old question with buffered background") {
      yield* execution;
      yield* question;
    } else
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
      (provider_session_id, thread_id, provider, status, updated_at, payload_json)
      VALUES ('ready', 'thread', 'codex', 'ready', ${old}, '{}')`;
    const drain = yield* DeploymentDrain.DeploymentDrain;
    const acquire = drain.execute({ operation: "acquire", leaseId, recoveryPolicy: "s97" });
    if (scenario === "idle") assert.equal((yield* acquire).state, "held");
    else {
      assert.equal(
        (yield* Effect.flip(acquire)).reason,
        scenario === "lookup failure" ? "inspection_failed" : "busy",
      );
      assert.equal((yield* drain.execute({ operation: "status" })).state, "open");
    }
  }).pipe(
    Effect.provide(
      DeploymentDrain.layer.pipe(
        Layer.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () =>
              scenario === "lookup failure"
                ? Effect.fail(
                    new ProviderSessionManager.ProviderSessionLookupError({
                      providerSessionId: ProviderSessionId.make("ready"),
                    }),
                  )
                : Effect.succeedSome({
                    hasPendingBackgroundWork: Effect.succeed(scenario !== "idle"),
                  } as ProviderAdapter.ProviderAdapterV2SessionRuntime),
          }),
        ),
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    ),
  ),
);

// These are rows in the complete, migrated database, including the retained
// NOT NULL provider shadows. No handwritten test DDL can mask schema drift.
const execution = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(Date.parse(now));
  yield* sql`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, payload_json)
    VALUES ('run', 'thread', 0, 'codex', 'provider-thread', 'waiting', ${old},
      ${JSON.stringify({ startedAt: old, activeAttemptId: "attempt", rootNodeId: "root" })})`;
  yield* sql`INSERT INTO orchestration_v2_projection_nodes
    (node_id, thread_id, run_id, root_node_id, parent_node_id, kind, status, payload_json)
    VALUES ('root', 'thread', 'run', 'root', NULL, 'provider_turn', 'waiting', '{}'),
      ('question-node', 'thread', 'run', 'root', 'root', 'tool', 'waiting', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
    (provider_thread_id, thread_id, provider, provider_session_id, status, updated_at, payload_json)
    VALUES ('provider-thread', 'thread', 'codex', 'session', 'active', ${old}, '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
    (provider_session_id, thread_id, provider, status, updated_at, payload_json)
    VALUES ('session', 'thread', 'codex', 'waiting', ${old}, '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_turns
    (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, payload_json)
    VALUES ('turn', 'thread', 'provider-thread', 'root', 'attempt', 0, 'running', '{}')`;
});
const question = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
    (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at, payload_json)
    VALUES ('question', 'thread', 'question-node', 'turn', 'user_input', 'pending', ${questionAt},
      ${JSON.stringify({ responseCapability: { type: "live", providerSessionId: "session" } })})`;
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items
    (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id, ordinal, type, status, updated_at, payload_json)
    VALUES ('ask-tool', 'thread', 'run', 'question-node', 'provider-thread', 'turn', 0, 'dynamic_tool', 'running', ${questionAt},
      '{"toolName":"AskUserQuestion","nativeItemRef":null}')`;
});

it.effect("S97 allows an owned question after 60 minutes but never calls it idle", () =>
  Effect.gen(function* () {
    yield* execution;
    yield* question;
    const drain = yield* DeploymentDrain.DeploymentDrain;
    assert.equal(
      (yield* Effect.flip(drain.execute({ operation: "acquire", leaseId }))).reason,
      "busy",
    );
    const held = yield* drain.execute({ operation: "acquire", leaseId, recoveryPolicy: "s97" });
    assert.equal(held.state, "held");
    if (held.state === "held") assert.equal(held.disposition, "s97-recovery");
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "fresh question",
  "newer question",
  "superseded question",
  "unsupported capability",
  "background command",
  "background roster",
  "app-owned child",
  "malformed timestamp",
  "malformed roster",
] as const)("%s prevents the old-question recovery exemption", (scenario) =>
  Effect.gen(function* () {
    yield* execution;
    yield* question;
    const sql = yield* SqlClient.SqlClient;
    const drain = yield* DeploymentDrain.DeploymentDrain;
    switch (scenario) {
      case "fresh question":
        yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET created_at = ${fresh}`;
        break;
      case "newer question":
        yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
          (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at, resolved_at, payload_json)
          SELECT 'newer-question', thread_id, node_id, provider_turn_id, kind, status, ${fresh}, resolved_at, payload_json
          FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = 'question'`;
        break;
      case "superseded question":
        yield* sql`UPDATE orchestration_v2_projection_runs SET requested_at = ${fresh},
          payload_json = ${JSON.stringify({ startedAt: fresh, rootNodeId: "root", activeAttemptId: "new-attempt" })}`;
        break;
      case "unsupported capability":
        yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET payload_json = '{"responseCapability":{"type":"live"}}'`;
        break;
      case "background command":
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, node_id, ordinal, type, status, updated_at, payload_json)
          VALUES ('command', 'thread', 'run', 'root', 1, 'command_execution', 'running', ${old}, '{}')`;
        break;
      case "background roster":
        yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json =
          '{"pendingBackgroundTasks":[{"kind":"command","taskId":"silent-command"}]}'`;
        break;
      case "app-owned child":
        yield* sql`INSERT INTO orchestration_v2_projection_subagents
          (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
          VALUES ('child', 'thread', 'root', 'codex', 'app_owned', 'running', ${old}, '{}')`;
        break;
      case "malformed timestamp":
        yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET created_at = 'invalid'`;
        break;
      case "malformed roster":
        yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{"pendingBackgroundTasks":{}}'`;
        break;
    }
    const result = yield* Effect.flip(
      drain.execute({ operation: "acquire", leaseId, recoveryPolicy: "s97" }),
    );
    assert.equal(
      result.reason,
      scenario === "malformed timestamp" || scenario === "malformed roster"
        ? "inspection_failed"
        : "busy",
    );
    assert.equal((yield* drain.execute({ operation: "status" })).state, "open");
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["silent", "event heartbeat", "item heartbeat"] as const)(
  "the 30-minute stall policy includes %s activity",
  (scenario) =>
    Effect.gen(function* () {
      yield* execution;
      const sql = yield* SqlClient.SqlClient;
      if (scenario === "event heartbeat")
        yield* sql`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES ('heartbeat', 'provider', 'thread', 1, 'provider.heartbeat', ${fresh}, 'system', '{}', '{}')`;
      if (scenario === "item heartbeat")
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('recent', 'thread', 'run', 0, 'text', 'completed', ${fresh}, '{}')`;
      const drain = yield* DeploymentDrain.DeploymentDrain;
      const acquire = drain.execute({ operation: "acquire", leaseId, recoveryPolicy: "s97" });
      if (scenario === "silent") {
        const held = yield* acquire;
        assert.isTrue(held.state === "held" && held.disposition === "s97-recovery");
      } else assert.equal((yield* Effect.flip(acquire)).reason, "busy");
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "native child question with unknown extra background = %s",
  (extraBackground) =>
    Effect.gen(function* () {
      yield* execution;
      yield* question;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_subagents
    (subagent_id, thread_id, parent_node_id, provider, provider_thread_id, origin, status, started_at, updated_at, payload_json)
    VALUES ('child', 'thread', 'root', 'codex', 'child-provider', 'provider_native', 'waiting', ${old}, ${old},
      '{"nativeTaskRef":{"nativeId":"native-child"}}')`;
      yield* sql`UPDATE orchestration_v2_projection_nodes SET parent_node_id = 'child' WHERE node_id = 'question-node'`;
      yield* sql`UPDATE orchestration_v2_projection_provider_sessions SET status = 'ready'`;
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = ${JSON.stringify(
        {
          pendingBackgroundTasks: [
            { kind: "subagent", taskId: "native-child" },
            ...(extraBackground ? [{ kind: "command", taskId: "unknown-command" }] : []),
          ],
        },
      )}`;
      const drain = yield* DeploymentDrain.DeploymentDrain;
      const acquire = drain.execute({ operation: "acquire", leaseId, recoveryPolicy: "s97" });
      if (extraBackground) assert.equal((yield* Effect.flip(acquire)).reason, "busy");
      else assert.equal((yield* acquire).state, "held");
    }).pipe(
      Effect.provide(
        DeploymentDrain.layer.pipe(
          Layer.provide(
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Effect.succeedSome({
                  hasPendingBackgroundWork: Effect.succeed(true),
                } as ProviderAdapter.ProviderAdapterV2SessionRuntime),
            }),
          ),
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    ),
);

it.effect("ready sessions and persistent tools do not block an idle lease", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
    (provider_session_id, thread_id, provider, status, updated_at, payload_json)
    VALUES ('ready', 'thread', 'codex', 'ready', ${old}, '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
    (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
    VALUES ('persistent', 'thread', 0, 'dynamic_tool', 'running', ${old}, '{"input":{"persistent":true}}')`;
    const drain = yield* DeploymentDrain.DeploymentDrain;
    const held = yield* drain.execute({ operation: "acquire", leaseId });
    assert.isTrue(held.state === "held" && held.disposition === "idle");
  }).pipe(Effect.provide(layerTest)),
);
