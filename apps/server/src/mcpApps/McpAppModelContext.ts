import type { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Longest context one app may keep for the agent. */
export const MCP_APP_MODEL_CONTEXT_MAX_CHARS = 16 * 1024;

export class McpAppModelContextError extends Schema.TaggedError<McpAppModelContextError>()(
  "McpAppModelContextError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

export interface McpAppModelContextEntry {
  readonly itemId: string;
  readonly server: string;
  readonly tool: string;
  readonly text: string;
}

/**
 * What each MCP App told the agent through `ui/update-model-context`. The spec
 * replaces an app's context on every update, so there is one entry per app (its
 * tool call); the thread's next turn carries the entries to the provider.
 */
export class McpAppModelContext extends Context.Service<
  McpAppModelContext,
  {
    /** Replaces the app's context; empty text removes it. */
    readonly set: (input: {
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
      readonly server: string;
      readonly tool: string;
      readonly text: string;
    }) => Effect.Effect<void, McpAppModelContextError>;
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<McpAppModelContextEntry>, McpAppModelContextError>;
  }
>()("t3/mcpApps/McpAppModelContext") {}

export const layer = Layer.effect(
  McpAppModelContext,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fail = (cause: unknown) => new McpAppModelContextError({ cause });

    const set = Effect.fn("McpAppModelContext.set")(function* (input: {
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
      readonly server: string;
      readonly tool: string;
      readonly text: string;
    }) {
      if (input.text.trim() === "") {
        yield* sql`
          DELETE FROM mcp_app_model_context
          WHERE thread_id = ${input.threadId} AND item_id = ${input.itemId}
        `.pipe(Effect.mapError(fail));
        return;
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO mcp_app_model_context (thread_id, item_id, server, tool, text, updated_at)
        VALUES (${input.threadId}, ${input.itemId}, ${input.server}, ${input.tool}, ${input.text}, ${updatedAt})
        ON CONFLICT(thread_id, item_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
      `.pipe(Effect.mapError(fail));
    });

    const forThread = Effect.fn("McpAppModelContext.forThread")(function* (threadId: ThreadId) {
      return yield* sql<McpAppModelContextEntry>`
        SELECT item_id AS "itemId", server, tool, text
        FROM mcp_app_model_context
        WHERE thread_id = ${threadId}
        ORDER BY updated_at, item_id
      `.pipe(Effect.mapError(fail));
    });

    return McpAppModelContext.of({ set, forThread });
  }),
);

/** No app context: for code paths and tests with no MCP Apps. */
export const layerEmpty = Layer.succeed(
  McpAppModelContext,
  McpAppModelContext.of({ set: () => Effect.void, forThread: () => Effect.succeed([]) }),
);
