import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Other environments this one signed in to as an outside MCP agent. The
  // session token itself is kept in the server secret store, not here.
  yield* sql`
    CREATE TABLE IF NOT EXISTS peer_environment_links (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      urls_json TEXT NOT NULL,
      access TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_reached_at TEXT,
      last_error TEXT
    )
  `;
});
