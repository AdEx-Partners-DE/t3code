/**
 * Lasting JSONL record, kept a few weeks in the state directory, of decisions the server takes
 * on its own (continue after restart, retry, move account, hold for queue pause). The trace log
 * rolls over within minutes, too fast to explain what happened overnight.
 * @module decisionLog
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "./config.ts";

const DECISION_LOG_FILE_NAME = "decision-log.jsonl";
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const encodeLine = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface Decision {
  /** What was decided, e.g. "restart-continuation", "start-failure-retry". */
  readonly kind: string;
  readonly threadId: string;
  /** What happened, in one word or two: "continued", "not-continued", "retried", "held". */
  readonly outcome: string;
  /** The facts the decision rested on. Values must be plain data. */
  readonly facts?: Readonly<Record<string, unknown>>;
}

export class DecisionLog extends Context.Service<
  DecisionLog,
  { readonly record: (decision: Decision) => Effect.Effect<void> }
>()("t3/decisionLog") {}

/** Lines younger than the retention, oldest first; unreadable lines are dropped. */
export function keepRecentDecisions(contents: string, nowMs: number): string {
  return contents
    .split("\n")
    .filter((line) => {
      if (line.trim() === "") return false;
      try {
        const at = Date.parse((JSON.parse(line) as { at?: string }).at ?? "");
        return Number.isFinite(at) && nowMs - at <= RETENTION_MS;
      } catch {
        return false;
      }
    })
    .map((line) => `${line}\n`)
    .join("");
}

export const layer = Layer.effect(
  DecisionLog,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const filePath = path.join(config.stateDir, DECISION_LOG_FILE_NAME);
    const lock = yield* Semaphore.make(1);
    // Trim once per start, so the file never grows past the retention.
    const existing = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.orElseSucceed(() => ""));
    const kept = keepRecentDecisions(existing, yield* Clock.currentTimeMillis);
    if (kept.length < existing.length) {
      yield* fileSystem.writeFileString(filePath, kept).pipe(Effect.ignore);
    }
    return DecisionLog.of({
      record: Effect.fn("DecisionLog.record")(function* (decision) {
        const at = DateTime.formatIso(yield* DateTime.now);
        // A record is a convenience; a full disk must not fail the decision itself.
        yield* fileSystem
          .writeFileString(filePath, `${encodeLine({ at, ...decision })}\n`, { flag: "a" })
          .pipe(Effect.ignore);
      }, lock.withPermits(1)),
    });
  }),
);

/** Records when the log is part of the running server, and does nothing in a harness without it. */
export const recordDecision = (decision: Decision): Effect.Effect<void> =>
  Effect.serviceOption(DecisionLog).pipe(
    Effect.flatMap((log) => (Option.isSome(log) ? log.value.record(decision) : Effect.void)),
  );
