import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WorkAdmission from "./WorkAdmission.ts";
import * as Semaphore from "effect/Semaphore";

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId> & {
    /**
     * One thread deletion plans and commits at a time: each decides what its deleted fork
     * sources keep for the forks still alive. Take it before any thread lock.
     */
    readonly withDeletionLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const make = Effect.gen(function* () {
  const admission = yield* WorkAdmission.WorkAdmission;
  const locks = yield* KeyedLock.make<ThreadId>();
  const deletion = yield* Semaphore.make(1);
  return ThreadCommandExecutor.of({
    activeKeys: locks.activeKeys,
    // Every command and provider event takes this lock; dispatch owns the trace span.
    withLock: Effect.fnUntraced(function* <A, E, R>(key: ThreadId, effect: Effect.Effect<A, E, R>) {
      return yield* admission.track(locks.withLock(key, effect));
    }),
    withDeletionLock: Effect.fn("ThreadCommandExecutor.withDeletionLock")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* deletion.withPermit(effect);
    }),
  });
});

export const layer = Layer.effect(ThreadCommandExecutor, make).pipe(
  Layer.provideMerge(WorkAdmission.layer),
);
