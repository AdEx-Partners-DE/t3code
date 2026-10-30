import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WorkAdmission from "./WorkAdmission.ts";

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId>
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(
  ThreadCommandExecutor,
  Effect.gen(function* () {
    const locks = yield* KeyedLock.make<ThreadId>();
    const admission = yield* WorkAdmission.WorkAdmission;
    // Runs on every command; the locked work owns its span.
    const withLock = <A, E, R>(key: ThreadId, effect: Effect.Effect<A, E, R>) =>
      admission.track(locks.withLock(key, effect));
    return ThreadCommandExecutor.of({ activeKeys: locks.activeKeys, withLock });
  }),
).pipe(Layer.provideMerge(WorkAdmission.layer));
