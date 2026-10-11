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

  return {
    /** The open threads with a waiting queue, the longest wait first. */
    read,
  };
});
