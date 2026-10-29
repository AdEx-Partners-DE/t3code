import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// S97 is permission to recover stale executions, not evidence that their
// processes stopped. Keep it opt-in and distinguish it in the lease result.
const Payload = Schema.fromJsonString(
  Schema.Struct({
    startedAt: Schema.optional(Schema.NullOr(Schema.String)),
    activeAttemptId: Schema.optional(Schema.NullOr(Schema.String)),
    rootNodeId: Schema.optional(Schema.NullOr(Schema.String)),
    responseCapability: Schema.optional(
      Schema.Struct({
        type: Schema.String,
        providerSessionId: Schema.optional(Schema.String),
      }),
    ),
    secretStatus: Schema.optional(Schema.String),
    input: Schema.optional(Schema.Unknown),
    origin: Schema.optional(Schema.String),
    toolName: Schema.optional(Schema.String),
    subagentId: Schema.optional(Schema.String),
    nativeTaskRef: Schema.optional(Schema.NullOr(Schema.Struct({ nativeId: Schema.String }))),
    nativeItemRef: Schema.optional(Schema.NullOr(Schema.Struct({ nativeId: Schema.String }))),
    pendingBackgroundTasks: Schema.optional(
      Schema.Array(
        Schema.Struct({
          taskId: Schema.String,
          kind: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
);
type Row = {
  readonly payload_json: string;
  readonly thread_id: string | null;
  readonly status: string;
  readonly run_id?: string | null;
  readonly subagent_id?: string;
  readonly origin?: string;
  readonly child_thread_id?: string | null;
  readonly provider_thread_id?: string | null;
  readonly provider_session_id?: string | null;
  readonly provider_turn_id?: string | null;
  readonly node_id?: string | null;
  readonly node_run_id?: string | null;
  readonly node_run_status?: string | null;
  readonly node_root_id?: string | null;
  readonly parent_node_id?: string | null;
  readonly run_attempt_id?: string | null;
  readonly turn_thread_id?: string | null;
  readonly turn_status?: string | null;
  readonly latest_turn?: number;
  readonly run_status?: string | null;
  readonly kind?: string;
  readonly type?: string;
  readonly turn_item_id?: string;
  readonly updated_at?: string;
  readonly started_at?: string | null;
  readonly requested_at?: string;
  readonly created_at?: string;
};
type DecodedRow = Row & { readonly data: typeof Payload.Type };
type Wait = {
  at: number;
  nodeId: string | null | undefined;
  parentNodeId?: string | null | undefined;
  kind?: string | undefined;
  secret: boolean;
};
type Unit = {
  kind: "run" | "subagent";
  row: DecodedRow;
  waits: Wait[];
  explicit: boolean;
  at: number;
};
const active = new Set(["pending", "starting", "running", "waiting"]);
const human = new Set([
  "user_input",
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);
const epoch = (value: string | null | undefined) => {
  if (value == null) return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid deployment activity timestamp");
  return parsed;
};
const newest = (...values: number[]) => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : NaN;
};
const decodePayload = Schema.decodeSync(Payload);
const decode = (rows: ReadonlyArray<Row>) =>
  rows.map((row) => ({ ...row, data: decodePayload(row.payload_json) }));

// A stale turn flag is history only when its entire owner chain is terminal
// and the provider thread has moved on. Missing owners never establish this.
export const terminalProviderTurnHistory = (sql: SqlClient.SqlClient) => sql`EXISTS (
  SELECT 1 FROM orchestration_v2_projection_run_attempts attempt
  JOIN orchestration_v2_projection_runs run ON run.run_id = attempt.run_id
  JOIN orchestration_v2_projection_nodes root ON root.node_id = attempt.root_node_id
  WHERE attempt.attempt_id = turn.run_attempt_id
    AND attempt.thread_id = turn.thread_id AND run.thread_id = turn.thread_id
    AND attempt.provider_thread_id = turn.provider_thread_id
    AND root.node_id = turn.node_id AND root.root_node_id = root.node_id
    AND root.run_id = run.run_id AND root.thread_id = turn.thread_id
    AND attempt.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'superseded')
    AND run.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
    AND root.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
    AND EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_turns newer
      WHERE newer.provider_thread_id = turn.provider_thread_id AND newer.ordinal > turn.ordinal)
)`;

// Compaction runs inside its provider turn and never outlives it, so a running
// compaction row whose turn is proven history is a projection leftover. Other
// item types (background commands) can outlive their turn and still block.
export const terminalCompactionHistory = (sql: SqlClient.SqlClient, item: "item" | "q") =>
  sql`(${sql.literal(item)}.type = 'compaction' AND EXISTS (
  SELECT 1 FROM orchestration_v2_projection_provider_turns turn
  WHERE turn.provider_turn_id = ${sql.literal(item)}.provider_turn_id
    AND ${terminalProviderTurnHistory(sql)}
))`;

export const inspectRecoveryPolicy = Effect.fn("DeploymentDrain.inspectRecoveryPolicy")(function* (
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  // The snapshot must include both execution ownership and heartbeat history.
  // Reading these independently can exempt a question from a superseded turn.
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const runs = decode(
        yield* sql<Row>`SELECT * FROM orchestration_v2_projection_runs
      WHERE status IN ('preparing', 'starting', 'running', 'waiting')`,
      );
      const subagents = decode(
        yield* sql<Row>`SELECT * FROM orchestration_v2_projection_subagents
      WHERE status IN ('pending', 'starting', 'running', 'waiting')`,
      );
      const ownership = sql`n.run_id AS node_run_id, n.root_node_id AS node_root_id, n.parent_node_id,
      r.status AS node_run_status, p.run_attempt_id, p.provider_thread_id AS turn_thread_id,
      p.status AS turn_status, NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_turns newer
        WHERE newer.provider_thread_id = p.provider_thread_id AND newer.ordinal > p.ordinal) AS latest_turn`;
      const requests = decode(
        yield* sql<Row>`SELECT q.*, ${ownership}
      FROM orchestration_v2_projection_runtime_requests q
      LEFT JOIN orchestration_v2_projection_nodes n ON n.node_id = q.node_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = n.run_id
      LEFT JOIN orchestration_v2_projection_provider_turns p ON p.provider_turn_id = q.provider_turn_id
      WHERE q.status = 'pending'`,
      );
      const items = decode(
        yield* sql<Row>`SELECT q.*, ${ownership}, item_run.status AS run_status
      FROM orchestration_v2_projection_turn_items q
      LEFT JOIN orchestration_v2_projection_nodes n ON n.node_id = q.node_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = n.run_id
      LEFT JOIN orchestration_v2_projection_runs item_run ON item_run.run_id = q.run_id
      LEFT JOIN orchestration_v2_projection_provider_turns p ON p.provider_turn_id = q.provider_turn_id
      WHERE q.status IN ('pending', 'running', 'waiting')
        AND q.type IN ('command_execution', 'dynamic_tool', 'subagent', 'secret_request',
          'file_change', 'file_search', 'web_search', 'compaction')
        AND (item_run.status IS NULL OR item_run.status <> 'rolled_back')
        AND NOT ${terminalCompactionHistory(sql, "q")}`,
      );
      const providers = decode(
        yield* sql<Row>`SELECT * FROM orchestration_v2_projection_provider_threads`,
      );
      const sessions = yield* sql<Row>`SELECT * FROM orchestration_v2_projection_provider_sessions
      WHERE status IN ('starting', 'running', 'waiting')`;
      const turns = yield* sql<Row>`SELECT * FROM orchestration_v2_projection_provider_turns turn
      WHERE status IN ('pending', 'running', 'waiting') AND NOT ${terminalProviderTurnHistory(sql)}`;
      const ownerNodeIds = [
        ...new Set(
          [...requests, ...items].flatMap((row) => (row.node_id == null ? [] : [row.node_id])),
        ),
      ];
      const nodes =
        ownerNodeIds.length === 0
          ? []
          : yield* sql<{ node_id: string; parent_node_id: string | null }>`
      WITH RECURSIVE ancestry AS (
        SELECT node_id, parent_node_id FROM orchestration_v2_projection_nodes WHERE ${sql.in("node_id", ownerNodeIds)}
        UNION SELECT n.node_id, n.parent_node_id FROM orchestration_v2_projection_nodes n
          JOIN ancestry a ON n.node_id = a.parent_node_id
      ) SELECT node_id, parent_node_id FROM ancestry`;
      // The canonical event store includes all aggregate kinds, including provider
      // heartbeats that don't change the run row. Item updates also count as life.
      const kinds = yield* sql<{
        aggregate_kind: string;
      }>`SELECT DISTINCT aggregate_kind FROM orchestration_events`;
      const threadIds = [
        ...new Set(
          [
            ...runs.map((row) => row.thread_id),
            ...subagents.map((row) => row.child_thread_id),
          ].filter((id): id is string => id != null),
        ),
      ];
      const activity = yield* Effect.forEach(threadIds, (threadId) =>
        sql<{ at: string | null }>`
      SELECT MAX(at) AS at FROM (
        SELECT MAX(occurred_at) AS at FROM orchestration_events
          WHERE ${sql.in(
            "aggregate_kind",
            kinds.map((row) => row.aggregate_kind),
          )} AND stream_id = ${threadId}
        UNION ALL SELECT MAX(updated_at) AS at FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}
      )`.pipe(Effect.map((rows) => ({ thread_id: threadId, at: rows[0]?.at ?? null }))),
      );
      const allowed = classify(
        { runs, subagents, requests, items, providers, sessions, turns, nodes, activity },
        now,
      );
      return {
        allowed: allowed !== false,
        backgroundSubagentIds: allowed ? allowed.backgroundSubagentIds : [],
      };
    }),
  );
});

function classify(
  snapshot: {
    runs: DecodedRow[];
    subagents: DecodedRow[];
    requests: DecodedRow[];
    items: DecodedRow[];
    providers: DecodedRow[];
    sessions: ReadonlyArray<Row>;
    turns: ReadonlyArray<Row>;
    nodes: ReadonlyArray<{ node_id: string; parent_node_id: string | null }>;
    activity: ReadonlyArray<{ thread_id: string; at: string | null }>;
  },
  now: number,
): false | { backgroundSubagentIds: string[] } {
  const { runs, subagents, requests, items, providers, sessions, turns } = snapshot;
  const activity = new Map(snapshot.activity.map((row) => [row.thread_id, epoch(row.at)]));
  const lastActivity = (id: string | null | undefined) =>
    id == null ? NaN : (activity.get(id) ?? NaN);
  const parents = new Map(snapshot.nodes.map((row) => [row.node_id, row.parent_node_id]));
  const units: Unit[] = runs.map((row) => ({
    kind: "run",
    row,
    waits: [],
    explicit: row.status === "preparing" || row.status === "starting",
    at: newest(lastActivity(row.thread_id), epoch(row.data.startedAt), epoch(row.requested_at)),
  }));
  for (const row of subagents)
    units.push({
      kind: "subagent",
      row,
      waits: [],
      explicit:
        row.origin === "app_owned" &&
        (row.child_thread_id == null || !runs.some((run) => run.thread_id === row.child_thread_id)),
      at: newest(
        epoch(row.updated_at),
        epoch(row.started_at),
        lastActivity(row.child_thread_id),
        epoch(
          providers.find((provider) => provider.provider_thread_id === row.provider_thread_id)
            ?.updated_at,
        ),
      ),
    });
  const runUnits = new Map(
    units.filter((unit) => unit.kind === "run").map((unit) => [unit.row.run_id, unit]),
  );
  const subagentUnits = new Map(
    units.filter((unit) => unit.kind === "subagent").map((unit) => [unit.row.subagent_id, unit]),
  );
  const owner = (row: DecodedRow): Unit | undefined => {
    const direct = units.find(
      (unit) =>
        unit.kind === "subagent" &&
        ((unit.row.child_thread_id != null && unit.row.child_thread_id === row.thread_id) ||
          (unit.row.provider_thread_id != null &&
            unit.row.provider_thread_id === row.turn_thread_id) ||
          unit.row.subagent_id === row.node_id ||
          unit.row.subagent_id === row.node_root_id),
    );
    if (direct) return direct;
    const visited = new Set<string>();
    for (let id = row.parent_node_id; id != null && !visited.has(id); id = parents.get(id)) {
      const unit = subagentUnits.get(id);
      if (unit) return unit;
      visited.add(id);
    }
    return (
      runUnits.get(row.run_id ?? row.node_run_id) ??
      units.find(
        (unit) =>
          unit.kind === "run" &&
          unit.row.thread_id === row.thread_id &&
          row.run_attempt_id != null &&
          unit.row.data.activeAttemptId === row.run_attempt_id,
      )
    );
  };
  const currentRequest = (row: DecodedRow, unit: Unit, at: number) => {
    const start = epoch(unit.kind === "run" ? unit.row.data.startedAt : unit.row.started_at);
    if (Number.isFinite(start) && Number.isFinite(at) && at < start) return false;
    if (row.provider_turn_id != null && row.turn_status == null) return null;
    if (
      unit.kind === "subagent" &&
      row.provider_turn_id != null &&
      row.turn_thread_id !== unit.row.provider_thread_id
    ) {
      return row.thread_id === unit.row.thread_id ? true : null;
    }
    if (row.provider_turn_id != null) {
      if (!active.has(row.turn_status ?? "") || !row.latest_turn) return false;
      if (unit.kind === "subagent") return true;
      if (unit.row.data.activeAttemptId == null || row.run_attempt_id == null) return null;
      return row.run_attempt_id === unit.row.data.activeAttemptId;
    }
    if (unit.kind === "subagent") return true;
    if (unit.row.data.rootNodeId == null) return null;
    return (
      row.thread_id === unit.row.thread_id &&
      (row.node_id === unit.row.data.rootNodeId || row.node_root_id === unit.row.data.rootNodeId)
    );
  };
  for (const request of requests) {
    const capability = request.data.responseCapability;
    if (
      capability?.type === "message" ||
      capability?.type === "not_resumable" ||
      request.kind === "dynamic_tool_call" ||
      request.kind === "auth_refresh"
    )
      continue;
    const unit = owner(request);
    if (!unit) {
      if (request.node_run_status == null) return false;
      continue;
    }
    const at = epoch(request.created_at);
    const current = currentRequest(request, unit, at);
    if (current === false) continue;
    if (
      current === null ||
      capability?.type !== "live" ||
      !human.has(request.kind ?? "") ||
      !capability.providerSessionId?.trim()
    ) {
      unit.explicit = true;
      continue;
    }
    unit.waits.push({
      at,
      nodeId: request.node_id,
      parentNodeId: request.parent_node_id,
      kind: request.kind,
      secret: false,
    });
  }
  for (const item of items.filter((row) => row.type === "secret_request")) {
    const unit = runUnits.get(item.run_id);
    if (!unit) continue;
    if (!["pending", "saved", "declined", "cancelled"].includes(item.data.secretStatus ?? ""))
      throw new Error("Invalid secret request status");
    if (item.data.secretStatus !== "pending" || item.node_id !== unit.row.data.rootNodeId) continue;
    const at = epoch(item.data.startedAt ?? item.updated_at);
    const current = currentRequest(item, unit, at);
    if (current === null) unit.explicit = true;
    else if (current) unit.waits.push({ at, nodeId: item.node_id, secret: true });
  }
  const taskKeys = new Map<string, Unit>();
  for (const unit of subagentUnits.values()) {
    if (unit.row.data.nativeTaskRef)
      taskKeys.set(`${unit.row.provider_thread_id}:${unit.row.data.nativeTaskRef.nativeId}`, unit);
  }
  for (const item of items) {
    if (item.type === "secret_request" || item.run_status === "queued") continue;
    if (item.type === "subagent" && item.data.origin === "app_owned") continue;
    if (
      item.type === "dynamic_tool" &&
      typeof item.data.input === "object" &&
      item.data.input !== null &&
      "persistent" in item.data.input &&
      item.data.input.persistent === true
    )
      continue;
    const unit = item.type === "subagent" ? subagentUnits.get(item.data.subagentId) : owner(item);
    if (!unit) return false;
    unit.at = newest(unit.at, epoch(item.updated_at));
    taskKeys.set(
      `${item.provider_thread_id}:${item.data.nativeItemRef?.nativeId ?? item.turn_item_id}`,
      unit,
    );
    if (item.type === "subagent") continue;
    const isRoot =
      item.node_id === item.node_root_id ||
      (unit.kind === "run" && item.node_id === unit.row.data.rootNodeId);
    const blocked = unit.waits.some(
      (wait) =>
        (!wait.secret &&
          !isRoot &&
          item.node_id != null &&
          (wait.kind !== "user_input" ||
            (item.type === "dynamic_tool" && item.data.toolName === "AskUserQuestion")) &&
          (wait.nodeId === item.node_id || wait.parentNodeId === item.node_id)) ||
        (wait.secret &&
          item.type === "dynamic_tool" &&
          /(?:^|[._/])request_secret$/.test(item.data.toolName ?? "")),
    );
    if (!blocked) unit.explicit = true;
  }
  for (const provider of providers) {
    for (const task of provider.data.pendingBackgroundTasks ?? []) {
      if (!task.taskId.trim()) throw new Error("Invalid pending background task");
      const known =
        taskKeys.get(`${provider.provider_thread_id}:${task.taskId}`) ??
        (task.kind === "subagent"
          ? units.find(
              (unit) =>
                unit.kind === "subagent" &&
                unit.row.data.nativeTaskRef?.nativeId === task.taskId &&
                unit.row.thread_id === provider.thread_id,
            )
          : undefined);
      if (!known) return false;
      if (known.kind !== "subagent" || task.kind !== "subagent" || !known.waits.length)
        known.explicit = true;
    }
  }
  // Active runtime records without a corresponding recoverable execution cannot
  // borrow another thread's old question or disappear just because they are old.
  for (const turn of turns) {
    if (
      !units.some((unit) =>
        unit.kind === "subagent"
          ? unit.row.provider_thread_id === turn.provider_thread_id
          : unit.row.data.activeAttemptId != null &&
            unit.row.data.activeAttemptId === turn.run_attempt_id,
      )
    )
      return false;
  }
  for (const session of sessions) {
    if (
      session.status === "starting" ||
      !units.some(
        (unit) =>
          unit.row.thread_id === session.thread_id ||
          providers.some(
            (provider) =>
              provider.provider_session_id === session.provider_session_id &&
              provider.provider_thread_id === unit.row.provider_thread_id,
          ),
      )
    )
      return false;
  }
  return (
    units.length > 0 &&
    units.every(
      (unit) =>
        !unit.explicit &&
        (unit.waits.length > 0
          ? unit.waits.every((wait) => Number.isFinite(wait.at) && now - wait.at >= 60 * 60_000)
          : Number.isFinite(unit.at) && now - unit.at >= 30 * 60_000),
    ) && {
      backgroundSubagentIds: [...subagentUnits.values()].flatMap((unit) =>
        unit.waits.length > 0 && unit.row.subagent_id !== undefined ? [unit.row.subagent_id] : [],
      ),
    }
  );
}
