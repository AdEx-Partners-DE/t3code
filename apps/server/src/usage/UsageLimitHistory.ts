/**
 * Append-only JSONL history of every account's quota-window readings, fed by the provider
 * registry with no probing of its own. Resets are derived from the readings at startup, so a
 * better rule for telling a reset from noise also corrects the past.
 * @module UsageLimitHistory
 */
import {
  UsageLimitHistoryPoint,
  UsageLimitReset,
  type ServerProvider,
  type UsageLimitHistory as UsageLimitHistoryResult,
  type UsageLimitHistoryInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  recordUsageLimitReadings,
  isRecordedUsageWindow,
  replayUsageLimitPoints,
  type UsageLimitReadingState,
} from "./usageLimitReadings.ts";

const USAGE_LIMIT_HISTORY_FILE_NAME = "usage-limit-history.jsonl";

/** Long enough to compare a few monthly windows; older lines are dropped at startup. */
const RETENTION_MS = 120 * 24 * 60 * 60_000;

// Files from before resets were worked out also hold reset lines. They are
// read past and dropped at the next startup rewrite.
const HistoryLine = Schema.Union([
  Schema.Struct({ point: UsageLimitHistoryPoint }),
  Schema.Struct({ reset: UsageLimitReset }),
]);
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(HistoryLine));
const encodeLine = Schema.encodeSync(Schema.fromJsonString(HistoryLine));

export class UsageLimitHistory extends Context.Service<
  UsageLimitHistory,
  {
    /** Points and resets at or after `since`, oldest first. */
    readonly read: (input: UsageLimitHistoryInput) => Effect.Effect<UsageLimitHistoryResult>;
  }
>()("t3/usage/UsageLimitHistory") {}

/**
 * The readings a history file holds, with unreadable and expired lines and
 * windows no longer recorded left out.
 */
export function parseUsageLimitHistory(contents: string, nowMs: number): UsageLimitHistoryPoint[] {
  const points: UsageLimitHistoryPoint[] = [];
  for (const raw of contents.split("\n")) {
    if (raw.trim() === "") continue;
    const line = decodeLine(raw);
    if (line._tag === "None" || !("point" in line.value)) continue;
    const point = line.value.point;
    if (nowMs - Date.parse(point.at) > RETENTION_MS) continue;
    if (!isRecordedUsageWindow({ id: point.windowId })) continue;
    points.push(point);
  }
  return points;
}

function serialize(points: ReadonlyArray<UsageLimitHistoryPoint>): string {
  return points.map((point) => `${encodeLine({ point })}\n`).join("");
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const filePath = path.join(config.stateDir, USAGE_LIMIT_HISTORY_FILE_NAME);

  const existing = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  const points = parseUsageLimitHistory(existing, yield* Clock.currentTimeMillis);
  const replayed = replayUsageLimitPoints(points);
  const resets: UsageLimitReset[] = [...replayed.resets];
  let state: UsageLimitReadingState = replayed.state;
  // Rewrite once at startup when lines expired or could not be read, so the
  // file never grows past the retention window.
  const kept = serialize(points);
  if (existing !== "" && kept.length < existing.length) {
    yield* fileSystem.writeFileString(filePath, kept).pipe(Effect.ignore);
  }

  const lock = yield* Semaphore.make(1);
  const record = (providers: ReadonlyArray<ServerProvider>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const delta = recordUsageLimitReadings(state, providers);
        if (delta.points.length === 0) return;
        state = delta.state;
        points.push(...delta.points);
        resets.push(...delta.resets);
        // History is a convenience; a full disk must not take usage limits down with it.
        yield* fileSystem
          .writeFileString(filePath, serialize(delta.points), { flag: "a" })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not append to the usage limit history", cause),
            ),
          );
      }),
    );

  yield* Stream.runForEach(registry.streamChanges, record).pipe(Effect.forkScoped);
  yield* registry.getProviders.pipe(Effect.flatMap(record));

  return UsageLimitHistory.of({
    read: Effect.fn("UsageLimitHistory.read")((input) =>
      Effect.sync(() => {
        const sinceMs = Date.parse(input.since);
        return {
          points: points.filter((point) => Date.parse(point.at) >= sinceMs),
          resets: resets.filter((reset) => Date.parse(reset.at) >= sinceMs),
        };
      }),
    ),
  });
});

export const layer = Layer.effect(UsageLimitHistory, make);
