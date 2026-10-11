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
    const rows = yield* sql<{ readonly thread_id: string; readonly last_event_at: string | null }>`
      SELECT
        runs.thread_id,
        (
          SELECT MAX(events.occurred_at)
          FROM orchestration_events AS events
          WHERE events.stream_id = runs.thread_id AND events.event_type <> 'thread.visited'
        ) AS last_event_at
      FROM orchestration_v2_projection_runs AS runs
      WHERE runs.status IN ('preparing', 'starting', 'running')
      GROUP BY runs.thread_id
    `;
    return rows.flatMap((row): ReadonlyArray<ActiveRun> =>
      row.last_event_at === null
        ? []
        : [{ threadId: row.thread_id as ThreadId, lastEventAt: row.last_event_at }],
    );
  });

  return {
    /** The open threads with a waiting queue, the longest wait first. */
    read,
    /** Every thread with a run under way and when it last showed a sign of life. */
    readActiveRuns,
  };
});
