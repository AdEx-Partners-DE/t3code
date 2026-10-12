/**
 * Which open threads have messages waiting in their queue, how many, and for
 * how long.
 *
 * A queue that stands still is silent: the thread looks idle and nothing says
 * that work is waiting behind a pause or a hold. This is the one read that
 * makes it visible across all threads at once.
 *
 * @module QueueOverview
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { isOpenThread } from "./OpenThreadModelOverride.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export interface WaitingQueue {
  readonly threadId: ThreadId;
  /** Messages waiting in the thread's queue. */
  readonly waiting: number;
  /** Of those, how many the thread's own hold keeps from starting. */
  readonly held: number;
  /** When the oldest of them was queued. */
  readonly oldestQueuedAt: string;
}

interface QueuedRow {
  readonly thread_id: string;
  readonly waiting: number;
  readonly held: number;
  readonly oldest: string;
}

export interface ActiveRun {
  readonly threadId: ThreadId;
  /** When anything last happened in the thread; a visit by the user does not count. */
  readonly lastEventAt: string;
}

export interface LastReply {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly at: string;
}

export interface PendingQuestion {
  readonly threadId: ThreadId;
  /** When the oldest unanswered question was asked. */
  readonly since: string;
}

export const REPLY_PREVIEW_LENGTH = 220;

/** A reply as one short line: whitespace folded, cut at a word where one is near. */
export function replyPreview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= REPLY_PREVIEW_LENGTH) return line;
  const cut = line.slice(0, REPLY_PREVIEW_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > REPLY_PREVIEW_LENGTH - 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Keeps the rows of open threads, the longest wait first. */
export function waitingQueuesOf(
  rows: ReadonlyArray<QueuedRow>,
  openThreadIds: ReadonlySet<string>,
): ReadonlyArray<WaitingQueue> {
  return rows
    .filter((row) => openThreadIds.has(row.thread_id))
    .map((row) => ({
      threadId: row.thread_id as ThreadId,
      waiting: row.waiting,
      held: row.held,
      oldestQueuedAt: row.oldest,
    }))
    .toSorted((left, right) => left.oldestQueuedAt.localeCompare(right.oldestQueuedAt));
}

/** Keeps the questions of open threads, the longest wait first. */
export function pendingQuestionsOf(
  rows: ReadonlyArray<{ readonly thread_id: string; readonly since: string }>,
  openThreadIds: ReadonlySet<string>,
): ReadonlyArray<PendingQuestion> {
  return rows
    .filter((row) => openThreadIds.has(row.thread_id))
    .map((row) => ({ threadId: row.thread_id as ThreadId, since: row.since }))
    .toSorted((left, right) => left.since.localeCompare(right.since));
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;

  const read = Effect.gen(function* () {
    const shell = yield* threads.getShellSnapshot();
    const rows = yield* sql<QueuedRow>`
      SELECT
        thread_id,
        COUNT(*) AS waiting,
        SUM(CASE WHEN json_extract(payload_json, '$.queueHeld') IS 1 THEN 1 ELSE 0 END) AS held,
        MIN(requested_at) AS oldest
      FROM orchestration_v2_projection_runs
      WHERE status = 'queued'
      GROUP BY thread_id
    `;
    return waitingQueuesOf(
      rows,
      new Set(shell.threads.filter(isOpenThread).map((thread) => thread.id as string)),
    );
  });

  // A run that is under way but whose thread has gone silent looks exactly
  // like one that works. The time of the last event tells them apart.
  const readActiveRuns = Effect.gen(function* () {
    const active = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id
      FROM orchestration_v2_projection_runs
      WHERE status IN ('preparing', 'starting', 'running')
    `;
    // The last event by sequence, through the index on (aggregate_kind,
    // stream_id, sequence). Taking MAX(occurred_at) instead read every event
    // of the thread: 300 ms and more for a long thread, on every refresh.
    const runs = yield* Effect.forEach(
      active,
      (row) =>
        sql<{ readonly occurred_at: string }>`
          SELECT occurred_at
          FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${row.thread_id}
            AND event_type <> 'thread.visited'
          ORDER BY sequence DESC
          LIMIT 1
        `.pipe(
          Effect.map((events): ReadonlyArray<ActiveRun> => {
            const last = events[0];
            return last === undefined
              ? []
              : [{ threadId: row.thread_id as ThreadId, lastEventAt: last.occurred_at }];
          }),
        ),
      { concurrency: 1 },
    );
    return runs.flat();
  });

  // Tool calls and auth refreshes are answered by the app, not by a person.
  // A question the thread has moved on from, with a turn started after it,
  // no longer holds the thread up and is not counted.
  const readPendingQuestions = Effect.gen(function* () {
    const shell = yield* threads.getShellSnapshot();
    const rows = yield* sql<{ readonly thread_id: string; readonly since: string }>`
      SELECT question.thread_id AS thread_id, MIN(question.created_at) AS since
      FROM orchestration_v2_projection_runtime_requests AS question
      WHERE question.status = 'pending'
        AND question.kind NOT IN ('dynamic_tool_call', 'auth_refresh')
        AND NOT EXISTS (
          SELECT 1
          FROM orchestration_v2_projection_runs AS run
          WHERE run.thread_id = question.thread_id
            AND json_extract(run.payload_json, '$.startedAt') > question.created_at
        )
      GROUP BY question.thread_id
    `;
    return pendingQuestionsOf(
      rows,
      new Set(shell.threads.filter(isOpenThread).map((thread) => thread.id as string)),
    );
  });

  // One indexed lookup per open thread. The text is cut in the database
  // first, so a long reply never leaves it whole.
  const readLastReplies = Effect.gen(function* () {
    const shell = yield* threads.getShellSnapshot();
    const replies = yield* Effect.forEach(
      shell.threads.filter(isOpenThread),
      (thread) =>
        sql<{ readonly text: string | null; readonly created_at: string }>`
          SELECT substr(json_extract(payload_json, '$.text'), 1, 2000) AS text, created_at
          FROM orchestration_v2_projection_messages
          WHERE thread_id = ${thread.id} AND role = 'assistant' AND streaming = 0
            AND trim(json_extract(payload_json, '$.text')) <> ''
          ORDER BY created_at DESC
          LIMIT 1
        `.pipe(
          Effect.map((rows): ReadonlyArray<LastReply> => {
            const row = rows[0];
            return row === undefined || row.text === null
              ? []
              : [{ threadId: thread.id, text: replyPreview(row.text), at: row.created_at }];
          }),
        ),
      { concurrency: 1 },
    );
    return replies.flat();
  });

  return {
    /** The open threads that wait for the user's answer, the longest wait first. */
    readPendingQuestions,
    /** For each open thread that has one, the start of its last reply. */
    readLastReplies,
    /** The open threads with a waiting queue, the longest wait first. */
    read,
    /** Every thread with a run under way and when it last showed a sign of life. */
    readActiveRuns,
  };
});
