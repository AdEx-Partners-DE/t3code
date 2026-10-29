import {
  NodeId,
  ProviderSessionId,
  ServerDrainError,
  type ServerDrainInput,
  type ServerDrainState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorkAdmission from "./WorkAdmission.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  inspectRecoveryPolicy,
  terminalCompactionHistory,
  terminalProviderTurnHistory,
} from "./DeploymentRecoveryPolicy.ts";
import type { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";

export class DeploymentDrain extends Context.Service<
  DeploymentDrain,
  {
    readonly execute: (
      input: ServerDrainInput,
    ) => Effect.Effect<ServerDrainState, ServerDrainError>;
  }
>()("t3/orchestration-v2/DeploymentDrain") {}

const make = Effect.gen(function* () {
  const admission = yield* WorkAdmission.WorkAdmission;
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  // These committed cleanup intents are replayed after process loss. Pending
  // retries don't execute work; a claimed cleanup is still counted until done.
  // Provider controls and checkpoint finalization are deliberately not exempt.
  const deferredCleanupTypes = [
    "scheduled-tasks.cleanup",
    "terminal.cleanup",
    "preview.cleanup",
    "attachment.cleanup",
  ] as const satisfies ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
  const blockingEffect = sql`status = 'running' OR (status = 'pending' AND NOT ${sql.in("effect_type", deferredCleanupTypes)})`;
  // One SQLite snapshot closes the outbox -> provider execution -> finalization
  // handoff gaps. Include delayed retries, not just currently claimable effects.
  // Ready sessions and queued messages do not execute work. The optional S97
  // disposition below authorizes recovery; it must never be reported as idle.
  const checkPersistedWork = sql<{ busy: number; pending_effects: number }>`
    SELECT (
      EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox WHERE ${blockingEffect})
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
        WHERE status IN ('preparing', 'starting', 'running', 'waiting'))
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_sessions
        WHERE status IN ('starting', 'running', 'waiting'))
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_turns turn
        WHERE status IN ('pending', 'running', 'waiting') AND NOT ${terminalProviderTurnHistory(sql)})
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents
        WHERE status IN ('pending', 'starting', 'running', 'waiting'))
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads
        WHERE json_array_length(payload_json, '$.pendingBackgroundTasks') > 0)
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items AS item
        WHERE item.type IN ('command_execution', 'dynamic_tool', 'subagent', 'file_change',
          'file_search', 'web_search', 'compaction')
          AND item.status IN ('pending', 'running', 'waiting')
          AND NOT (item.type = 'dynamic_tool'
            AND COALESCE(json_type(item.payload_json, '$.input.persistent'), '') = 'true')
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS run
            WHERE run.run_id = item.run_id AND run.status = 'rolled_back')
          AND NOT ${terminalCompactionHistory(sql, "item")})
    ) AS busy,
    EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox WHERE ${blockingEffect}) AS pending_effects
  `.pipe(Effect.mapError((cause) => new ServerDrainError({ reason: "inspection_failed", cause })));

  const checkIdle = Effect.fn("DeploymentDrain.checkIdle")(function* (recoveryPolicy?: "s97") {
    const [snapshot] = yield* checkPersistedWork;
    if (snapshot === undefined) return yield* new ServerDrainError({ reason: "inspection_failed" });
    const disposition = snapshot.busy === 0 ? "idle" : "s97-recovery";
    let backgroundSubagentIds: readonly NodeId[] = [];
    if (snapshot.busy !== 0) {
      if (snapshot.pending_effects !== 0 || recoveryPolicy !== "s97")
        return yield* new ServerDrainError({ reason: "busy" });
      const policy = yield* inspectRecoveryPolicy(yield* Clock.currentTimeMillis).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchCause((cause) =>
          Effect.fail(new ServerDrainError({ reason: "inspection_failed", cause })),
        ),
      );
      if (!policy.allowed) return yield* new ServerDrainError({ reason: "busy" });
      backgroundSubagentIds = policy.backgroundSubagentIds.map((id) => NodeId.make(id));
    }
    const liveSessions = yield* sql<{ provider_session_id: string }>`
      SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions
      WHERE status IN ('ready', 'starting', 'running', 'waiting')
    `.pipe(
      Effect.mapError((cause) => new ServerDrainError({ reason: "inspection_failed", cause })),
    );
    for (const row of liveSessions) {
      const runtime = yield* sessions
        .get(ProviderSessionId.make(row.provider_session_id))
        .pipe(
          Effect.mapError((cause) => new ServerDrainError({ reason: "inspection_failed", cause })),
        );
      if (Option.isNone(runtime)) continue;
      const probe = runtime.value.hasPendingBackgroundWorkExceptSubagents;
      const pending =
        probe !== undefined
          ? probe(backgroundSubagentIds)
          : (runtime.value.hasPendingBackgroundWork ?? Effect.succeed(true));
      if (
        yield* pending.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(new ServerDrainError({ reason: "inspection_failed", cause })),
          ),
        )
      )
        return yield* new ServerDrainError({ reason: "busy" });
    }
    return disposition;
  });

  return DeploymentDrain.of({
    execute: Effect.fn("DeploymentDrain.execute")(function* (input) {
      switch (input.operation) {
        case "acquire":
          return yield* admission.acquire(input.leaseId, checkIdle(input.recoveryPolicy));
        case "cancel":
          return yield* admission.cancel(input.leaseId);
        case "status":
          return yield* admission.status;
      }
    }),
  });
});

export const layer = Layer.effect(DeploymentDrain, make).pipe(Layer.provide(WorkAdmission.layer));
