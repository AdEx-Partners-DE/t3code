/**
 * Lets an update in when tasks run on a timer around the clock.
 *
 * An update restarts the server only while no agent works. With several tasks
 * on a short timer there is no such moment. So whoever has an update ready
 * writes a marker into the data directory, and while it is valid no task
 * starts by itself: the turns under way finish, the server can be restarted,
 * and the tasks that were due run right after. The marker carries its own end
 * and is capped, so a forgotten one cannot keep tasks back.
 *
 * @module updateHold
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export const UPDATE_HOLD_FILE_NAME = "update-pending.json";
/** The longest a marker can keep tasks back, whatever it asks for. */
export const UPDATE_HOLD_MAX_MS = 20 * 60_000;

const Marker = Schema.Struct({ at: Schema.String, until: Schema.String });
const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(Marker));

/**
 * When the hold a marker asks for ends, in epoch milliseconds, or null when
 * it does not hold now: unreadable, over, or written in the future.
 */
export function updateHoldEndsAt(contents: string, nowMs: number): number | null {
  const marker = decodeMarker(contents);
  if (Option.isNone(marker)) return null;
  const at = Date.parse(marker.value.at);
  const until = Date.parse(marker.value.until);
  if (!Number.isFinite(at) || !Number.isFinite(until) || at > nowMs) return null;
  const endsAt = Math.min(until, at + UPDATE_HOLD_MAX_MS);
  return nowMs < endsAt ? endsAt : null;
}

/** When the current update hold ends, or null without one. Missing services or file mean none. */
export const currentUpdateHold = Effect.gen(function* () {
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  if (Option.isNone(fileSystem) || Option.isNone(path) || Option.isNone(config)) return null;
  const contents = yield* fileSystem.value
    .readFileString(path.value.join(config.value.stateDir, UPDATE_HOLD_FILE_NAME))
    .pipe(Effect.orElseSucceed(() => ""));
  return contents === "" ? null : updateHoldEndsAt(contents, yield* Clock.currentTimeMillis);
});
