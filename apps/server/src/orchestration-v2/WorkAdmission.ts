import { ServerDrainError, type ServerDrainState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

// A fork inherits the reference, but may only reuse it while the admitting
// operation is still alive. Detached work cannot retain admission indefinitely.
class CurrentAdmission extends Context.Reference<symbol | undefined>(
  "t3/orchestration-v2/CurrentAdmission",
  { defaultValue: () => undefined },
) {}

export class WorkAdmission extends Context.Service<
  WorkAdmission,
  {
    readonly run: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerDrainError, R>;
    readonly track: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly whenOpen: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A | undefined, E, R>;
    readonly reopened: Stream.Stream<void>;
    readonly awaitOpen: Effect.Effect<void>;
    readonly status: Effect.Effect<ServerDrainState>;
    readonly acquire: <E, R>(
      leaseId: string,
      checkIdle: Effect.Effect<void | "idle" | "s97-recovery", E, R>,
    ) => Effect.Effect<ServerDrainState, E | ServerDrainError, R>;
    readonly cancel: (leaseId: string) => Effect.Effect<ServerDrainState, ServerDrainError>;
  }
>()("t3/orchestration-v2/WorkAdmission") {}

const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const reopened = yield* PubSub.unbounded<void>();
  const admitted = new Set<symbol>();
  let operations = 0;
  let revision = 0;
  let lease:
    | {
        readonly id: string;
        readonly expiresAt: number;
        drained: Deferred.Deferred<void>;
        readonly released: Deferred.Deferred<void>;
        state: "acquiring" | "held";
        disposition: "idle" | "s97-recovery" | undefined;
      }
    | undefined;

  const status = Effect.sync((): ServerDrainState =>
    lease === undefined
      ? { state: "open", pid: process.pid }
      : lease.state === "held"
        ? {
            state: "held",
            pid: process.pid,
            leaseId: lease.id,
            expiresAt: lease.expiresAt,
            disposition: lease.disposition ?? "idle",
          }
        : { state: "acquiring", pid: process.pid, leaseId: lease.id, expiresAt: lease.expiresAt },
  );
  const release = Effect.fn("WorkAdmission.release")(function* (expected: typeof lease) {
    if (lease === undefined || lease !== expected) return;
    const previous = lease;
    lease = undefined;
    yield* Deferred.succeed(previous.released, undefined);
    yield* PubSub.publish(reopened, undefined);
  }, Effect.uninterruptible);
  const finish = Effect.suspend(() => {
    operations -= 1;
    return operations === 0 && lease !== undefined
      ? Deferred.succeed(lease.drained, undefined).pipe(Effect.asVoid)
      : Effect.void;
  });
  const begin = () => {
    revision += 1;
    operations += 1;
    if (operations === 1 && lease !== undefined) lease.drained = Deferred.makeUnsafe<void>();
  };

  // These wrappers run on every command and provider event; the enclosed service
  // already owns its span. Registration and finalizer installation cannot yield.
  const track = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        begin();
        return restore(effect).pipe(Effect.ensuring(finish));
      }),
    );
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(CurrentAdmission, (parent) =>
        Effect.suspend((): Effect.Effect<A, E | ServerDrainError, R> => {
          if (lease !== undefined && (parent === undefined || !admitted.has(parent))) {
            return Effect.fail(new ServerDrainError({ reason: "admission_closed" }));
          }
          const permit = Symbol();
          admitted.add(permit);
          begin();
          return restore(effect).pipe(
            Effect.provideService(CurrentAdmission, permit),
            Effect.ensuring(
              Effect.sync(() => admitted.delete(permit)).pipe(Effect.andThen(finish)),
            ),
          );
        }),
      ),
    );

  const whenOpen = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend((): Effect.Effect<A | undefined, E, R> => {
        if (lease !== undefined) return Effect.undefined;
        const permit = Symbol();
        admitted.add(permit);
        begin();
        return restore(effect).pipe(
          Effect.provideService(CurrentAdmission, permit),
          Effect.ensuring(Effect.sync(() => admitted.delete(permit)).pipe(Effect.andThen(finish))),
        );
      }),
    );

  const acquire = Effect.fn("WorkAdmission.acquire")(function* <E, R>(
    id: string,
    checkIdle: Effect.Effect<void | "idle" | "s97-recovery", E, R>,
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const current = {
          id,
          expiresAt: now + 120_000,
          drained: Deferred.makeUnsafe<void>(),
          released: Deferred.makeUnsafe<void>(),
          state: "acquiring" as "acquiring" | "held",
          disposition: undefined as "idle" | "s97-recovery" | undefined,
        };
        const acquired = yield* Effect.suspend(() => {
          if (lease !== undefined) {
            return lease.id === id && lease.state === "held"
              ? Effect.succeed(false)
              : Effect.fail(new ServerDrainError({ reason: "lease_conflict" }));
          }
          lease = current;
          return (
            operations === 0 ? Deferred.succeed(current.drained, undefined) : Effect.void
          ).pipe(Effect.as(true));
        });
        if (!acquired) return yield* status;
        yield* Deferred.await(current.released).pipe(
          Effect.timeoutOrElse({ duration: "120 seconds", orElse: () => Effect.void }),
          Effect.andThen(release(current)),
          Effect.forkIn(scope),
        );
        return yield* restore(
          Effect.gen(function* () {
            // Cleanup and provider events remain allowed. If either overlaps the
            // snapshot, wait for its commit and inspect again before granting.
            while (true) {
              yield* Deferred.await(current.drained);
              const observed = revision;
              const disposition = yield* checkIdle;
              if (lease !== current) return yield* new ServerDrainError({ reason: "expired" });
              if (operations !== 0 || revision !== observed) continue;
              current.state = "held";
              current.disposition = disposition ?? "idle";
              return yield* status;
            }
          }).pipe(
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () => Effect.fail(new ServerDrainError({ reason: "timeout" })),
            }),
            Effect.raceFirst(
              Deferred.await(current.released).pipe(
                Effect.andThen(Effect.fail(new ServerDrainError({ reason: "expired" }))),
              ),
            ),
          ),
        ).pipe(Effect.onError(() => release(current)));
      }),
    );
  });

  return WorkAdmission.of({
    run,
    track,
    whenOpen,
    reopened: Stream.fromPubSub(reopened),
    awaitOpen: Effect.suspend(() =>
      lease === undefined ? Effect.void : Deferred.await(lease.released),
    ),
    status,
    acquire,
    cancel: Effect.fn("WorkAdmission.cancel")(function* (id) {
      if (lease !== undefined && lease.id !== id) {
        return yield* new ServerDrainError({ reason: "lease_conflict" });
      }
      yield* release(lease);
      return yield* status;
    }),
  });
});

export const layer = Layer.effect(WorkAdmission, make);
