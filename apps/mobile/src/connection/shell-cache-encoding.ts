import {
  type Persistence,
  StoredOrchestrationShellSnapshot,
} from "@t3tools/client-runtime/platform";
import { OrchestrationV2ThreadShellJson, ThreadPullRequestLink } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const ROWS_PER_CHUNK = 32;

// Effect's cooperative yield resumes through microtasks on React Native. A host
// timer lets input and rendering run between chunks of shell rows instead.
const yieldToHost = Effect.callback<void>((resume) => {
  const timer = setTimeout(() => resume(Effect.void), 0);
  return Effect.sync(() => clearTimeout(timer));
});

// Rows go through the canonical row codec in chunks. The envelope codec then
// validates and encodes everything else, passing the encoded rows through as-is.
const encodeThreadChunk = Schema.encodeEffect(Schema.Array(OrchestrationV2ThreadShellJson));
const EncodedRows = Schema.Array(Schema.Unknown);
const encodeEnvelope = Schema.encodeEffect(
  Schema.fromJsonString(
    StoredOrchestrationShellSnapshot.mapFields((fields) => ({
      ...fields,
      snapshot: fields.snapshot.mapFields((snapshotFields) => ({
        ...snapshotFields,
        threads: EncodedRows,
        archivedThreads: EncodedRows,
      })),
    })),
  ),
);

/**
 * Encode the shell cache payload exactly like `fromJsonString(StoredOrchestrationShellSnapshot)`,
 * yielding to the host between bounded chunks of thread rows. The final envelope encode and
 * JSON stringify still run synchronously over the whole payload.
 */
export const encodeStoredShellSnapshot = Effect.fnUntraced(function* (
  stored: typeof StoredOrchestrationShellSnapshot.Type,
) {
  let hasWorked = false;
  const yieldBetweenChunks = Effect.suspend(() => {
    if (hasWorked) return yieldToHost;
    hasWorked = true;
    return Effect.void;
  });
  const encodeRows = (rows: ReadonlyArray<OrchestrationV2ThreadShellJson>) =>
    Effect.gen(function* () {
      const encoded: Array<unknown> = [];
      for (let start = 0; start < rows.length; start += ROWS_PER_CHUNK) {
        yield* yieldBetweenChunks;
        const chunk = yield* encodeThreadChunk(rows.slice(start, start + ROWS_PER_CHUNK));
        for (const row of chunk) encoded.push(row);
      }
      return encoded;
    });

  const { snapshot } = stored;
  const threads = yield* encodeRows(snapshot.threads);
  const archivedThreads = yield* encodeRows(snapshot.archivedThreads);
  yield* yieldBetweenChunks;
  return yield* encodeEnvelope({ ...stored, snapshot: { ...snapshot, threads, archivedThreads } });
});

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeStoredShell = Schema.decodeUnknownEffect(StoredOrchestrationShellSnapshot);
const decodePullRequestLinks = Schema.decodeUnknownEffect(
  Schema.Array(Schema.UndefinedOr(Schema.Array(ThreadPullRequestLink))),
);

/** Removes each parsed thread row's pull request links and returns them in row order. */
function detachPullRequests(parsed: unknown): ReadonlyArray<unknown> {
  if (!Predicate.isObject(parsed) || !Predicate.isObject(parsed.snapshot)) return [];
  const rows: unknown = parsed.snapshot.threads;
  if (!Array.isArray(rows)) return [];
  return rows.map((row: unknown) => {
    if (!Predicate.isObject(row)) return undefined;
    const links = row.pullRequests;
    delete row.pullRequests;
    return links;
  });
}

/**
 * Decode the shell cache payload with each thread's pull request links left out. Those links
 * are most of a large cache's decode cost and only feed PR badges, so the thread list can
 * paint first; `loadPullRequests` decodes them after yielding to the host.
 */
export const decodeStoredShellSnapshot = Effect.fnUntraced(function* (
  raw: string,
): Effect.fn.Return<
  Omit<typeof StoredOrchestrationShellSnapshot.Type, "snapshot"> & {
    readonly snapshot: Persistence.CachedShellSnapshot;
  },
  Schema.SchemaError
> {
  const parsed = yield* decodeJson(raw);
  const rawLinks = detachPullRequests(parsed);
  const stored = yield* decodeStoredShell(parsed);
  const threadIds = stored.snapshot.threads.map((thread) => thread.id);
  const loadPullRequests = yieldToHost.pipe(
    // Schema decoding runs when called, so build the decode only after the yield.
    Effect.andThen(Effect.suspend(() => decodePullRequestLinks(rawLinks))),
    Effect.map(
      (links) =>
        new Map(
          threadIds.flatMap((threadId, index) => {
            const threadLinks = links[index];
            return threadLinks === undefined ? [] : [[threadId, threadLinks] as const];
          }),
        ),
    ),
    // The rows stay usable without links; the next server snapshot replaces them.
    Effect.catch((cause) =>
      Effect.logWarning("Discarding unreadable cached pull request links.", {
        environmentId: stored.environmentId,
        cause: String(cause),
      }).pipe(Effect.as(new Map())),
    ),
  );
  const snapshot: Persistence.CachedShellSnapshot = { ...stored.snapshot, loadPullRequests };
  return { ...stored, snapshot };
});
