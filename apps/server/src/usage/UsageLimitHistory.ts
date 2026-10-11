/**
 * Keeps the history of every account's quota windows: how the allowance was
 * used over time, and what was left each time a window reset.
 *
 * It listens to the provider registry, so it records whatever the usage
 * probes already read and adds no probing of its own. The history is an
 * append-only file in the state directory, one JSON object per line.
 *
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
  usageLimitWindowKey,
  type UsageLimitReadingState,
} from "./usageLimitReadings.ts";

export const USAGE_LIMIT_HISTORY_FILE_NAME = "usage-limit-history.jsonl";

/** Long enough to compare a few monthly windows; older lines are dropped at startup. */
const RETENTION_MS = 120 * 24 * 60 * 60_000;

const HistoryLine = Schema.Union([
  Schema.Struct({ point: UsageLimitHistoryPoint }),
  Schema.Struct({ reset: UsageLimitReset }),
]);
type HistoryLine = typeof HistoryLine.Type;
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(HistoryLine));
const encodeLine = Schema.encodeSync(Schema.fromJsonString(HistoryLine));

export class UsageLimitHistory extends Context.Service<
  UsageLimitHistory,
  {
    /** Points and resets at or after `since`, oldest first. */
    readonly read: (input: UsageLimitHistoryInput) => Effect.Effect<UsageLimitHistoryResult>;
  }
>()("t3/usage/UsageLimitHistory") {}

/** What a history file holds, with unreadable and expired lines left out. */
export function parseUsageLimitHistory(
  contents: string,
  nowMs: number,
): { readonly points: UsageLimitHistoryPoint[]; readonly resets: UsageLimitReset[] } {
  const points: UsageLimitHistoryPoint[] = [];
  const resets: UsageLimitReset[] = [];
  for (const raw of contents.split("\n")) {
    if (raw.trim() === "") continue;
    const line = decodeLine(raw);
    if (line._tag === "None") continue;
    const entry = line.value;
    const at = "point" in entry ? entry.point.at : entry.reset.at;
    if (nowMs - Date.parse(at) > RETENTION_MS) continue;
    if ("point" in entry) points.push(entry.point);
    else resets.push(entry.reset);
  }
  return { points, resets };
}

function serialize(lines: ReadonlyArray<HistoryLine>): string {
  return lines.map((line) => `${encodeLine(line)}\n`).join("");
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const filePath = path.join(config.stateDir, USAGE_LIMIT_HISTORY_FILE_NAME);

  const existing = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  const loaded = parseUsageLimitHistory(existing, yield* Clock.currentTimeMillis);
  const points = loaded.points;
  const resets = loaded.resets;
  let state: UsageLimitReadingState = new Map(
    points.map((point) => [usageLimitWindowKey(point), point]),
  );
  // Rewrite once at startup when lines expired or could not be read, so the
  // file never grows past the retention window.
  const kept = serialize([
    ...points.map((point) => ({ point })),
    ...resets.map((reset) => ({ reset })),
  ]);
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
          .writeFileString(
            filePath,
            serialize([
              ...delta.points.map((point) => ({ point })),
              ...delta.resets.map((reset) => ({ reset })),
            ]),
            { flag: "a" },
          )
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
    read: (input) =>
      Effect.sync(() => {
        const sinceMs = Date.parse(input.since);
        return {
          points: points.filter((point) => Date.parse(point.at) >= sinceMs),
          resets: resets.filter((reset) => Date.parse(reset.at) >= sinceMs),
        };
      }),
  });
});

export const layer = Layer.effect(UsageLimitHistory, make);

/** Empty history, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  UsageLimitHistory,
  UsageLimitHistory.of({ read: () => Effect.succeed({ points: [], resets: [] }) }),
);
