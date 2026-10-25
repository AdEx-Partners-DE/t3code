import { assert, it } from "@effect/vitest";
import { ServerDrainError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as WorkAdmission from "./WorkAdmission.ts";

const leaseId = "bb379c6e-bede-41f2-8dd3-7977b0a41385";
const otherLeaseId = "0399d9f5-985b-4be9-936c-a9b5f8445db6";

it.effect.each(["in flight", "already committed"] as const)(
  "rechecks cleanup registered after the first snapshot, %s",
  (mode) =>
    Effect.gen(function* () {
      const admission = yield* WorkAdmission.WorkAdmission;
      const inspected = yield* Deferred.make<void>();
      const finishInspection = yield* Deferred.make<void>();
      const cleanupEntered = yield* Deferred.make<void>();
      const cleanupCommit = yield* Deferred.make<void>();
      let inspections = 0;
      let busy = false;
      const acquiring = yield* Effect.flip(
        admission.acquire(
          leaseId,
          Effect.gen(function* () {
            inspections += 1;
            const snapshotBusy = busy;
            if (inspections === 1) {
              yield* Deferred.succeed(inspected, undefined);
              yield* Deferred.await(finishInspection);
            }
            if (snapshotBusy) return yield* new ServerDrainError({ reason: "busy" });
          }),
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(inspected);
      const cleanup = yield* admission
        .track(
          Deferred.succeed(cleanupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(cleanupCommit)),
            Effect.andThen(
              Effect.sync(() => {
                busy = true;
              }),
            ),
          ),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(cleanupEntered);
      if (mode === "already committed") {
        yield* Deferred.succeed(cleanupCommit, undefined);
        yield* Fiber.join(cleanup);
      }
      yield* Deferred.succeed(finishInspection, undefined);
      if (mode === "in flight") assert.equal((yield* admission.status).state, "acquiring");
      yield* Deferred.succeed(cleanupCommit, undefined);
      yield* Fiber.join(cleanup);
      assert.equal((yield* Fiber.join(acquiring)).reason, "busy");
      assert.equal(inspections, 2);
      assert.equal((yield* admission.status).state, "open");
    }).pipe(Effect.provide(WorkAdmission.layer)),
);

it.effect("explicit cancel during inspection cannot grant or release a replacement lease", () =>
  Effect.gen(function* () {
    const admission = yield* WorkAdmission.WorkAdmission;
    const entered = yield* Deferred.make<void>();
    const acquiring = yield* Effect.flip(
      admission.acquire(
        leaseId,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    yield* admission.cancel(leaseId);
    yield* admission.acquire(otherLeaseId, Effect.void);
    assert.equal((yield* Fiber.join(acquiring)).reason, "expired");
    assert.equal((yield* admission.status).state, "held");
  }).pipe(Effect.provide(WorkAdmission.layer)),
);

it.effect("closes admission before awaiting admitted commits, while allowing cleanup", () =>
  Effect.gen(function* () {
    const admission = yield* WorkAdmission.WorkAdmission;
    const entered = yield* Deferred.make<void>();
    const commit = yield* Deferred.make<void>();
    const inspected = yield* Ref.make(false);
    const command = yield* admission
      .run(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(commit))))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const acquire = yield* admission
      .acquire(leaseId, Ref.set(inspected, true))
      .pipe(Effect.forkChild({ startImmediately: true }));
    assert.equal((yield* admission.status).state, "acquiring");
    assert.isFalse(yield* Ref.get(inspected));
    assert.deepEqual(
      yield* Effect.flip(admission.run(Effect.void)),
      new ServerDrainError({ reason: "admission_closed" }),
    );
    yield* admission.track(Effect.void);
    yield* Deferred.succeed(commit, undefined);
    yield* Fiber.join(command);
    assert.equal((yield* Fiber.join(acquire)).state, "held");
    assert.isTrue(yield* Ref.get(inspected));
    assert.isUndefined(yield* admission.whenOpen(Effect.die("Queue promotion bypassed admission")));
  }).pipe(Effect.provide(WorkAdmission.layer)),
);

it.effect("counts nested admitted work and rejects a detached fork's expired permit", () =>
  Effect.gen(function* () {
    const admission = yield* WorkAdmission.WorkAdmission;
    const innerStarted = yield* Deferred.make<void>();
    const finishInner = yield* Deferred.make<void>();
    const parentStarted = yield* Deferred.make<void>();
    const continueParent = yield* Deferred.make<void>();
    const lateFork = yield* Deferred.make<void>();
    const parent = yield* admission
      .run(
        Effect.gen(function* () {
          yield* Deferred.succeed(parentStarted, undefined);
          yield* Deferred.await(continueParent);
          yield* admission.run(
            Deferred.succeed(innerStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishInner)),
            ),
          );
          return yield* Deferred.await(lateFork).pipe(
            Effect.andThen(admission.run(Effect.void)),
            Effect.result,
            Effect.forkScoped({ startImmediately: true }),
          );
        }),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(parentStarted);
    const acquired = yield* admission
      .acquire(leaseId, Effect.void)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(continueParent, undefined);
    yield* Deferred.await(innerStarted);
    assert.equal((yield* admission.status).state, "acquiring");
    yield* Deferred.succeed(finishInner, undefined);
    const detached = yield* Fiber.join(parent);
    assert.equal((yield* Fiber.join(acquired)).state, "held");
    yield* Deferred.succeed(lateFork, undefined);
    const result = yield* Fiber.join(detached);
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(WorkAdmission.layer), Effect.scoped),
);

it.effect.each(["busy", "inspection_failed"] as const)(
  "%s acquisition reopens admission",
  (failure) =>
    Effect.gen(function* () {
      const admission = yield* WorkAdmission.WorkAdmission;
      const error = yield* Effect.flip(
        admission.acquire(leaseId, Effect.fail(new ServerDrainError({ reason: failure }))),
      );
      assert.equal(error.reason, failure);
      assert.equal((yield* admission.status).state, "open");
      assert.equal(yield* admission.run(Effect.succeed("accepted")), "accepted");
    }).pipe(Effect.provide(WorkAdmission.layer)),
);

it.effect("failed and interrupted inspections reopen admission", () =>
  Effect.gen(function* () {
    const admission = yield* WorkAdmission.WorkAdmission;
    const entered = yield* Deferred.make<void>();
    const acquiring = yield* admission
      .acquire(leaseId, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(acquiring);
    assert.equal((yield* admission.status).state, "open");
    yield* Effect.exit(admission.acquire(leaseId, Effect.die("inspection defect")));
    assert.equal((yield* admission.status).state, "open");
  }).pipe(Effect.provide(WorkAdmission.layer)),
);

it.effect("times out waiting for admission and leaves the original command alive", () =>
  Effect.gen(function* () {
    const admission = yield* WorkAdmission.WorkAdmission;
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const command = yield* admission
      .run(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const acquiring = yield* Effect.flip(
      admission.acquire(leaseId, Effect.die("must await command")),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("10 seconds");
    assert.equal((yield* Fiber.join(acquiring)).reason, "timeout");
    assert.equal((yield* admission.status).state, "open");
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(command);
  }).pipe(Effect.provide(WorkAdmission.layer)),
);

it.effect(
  "lease expires, notifies queues, and explicit cancellation cannot release another lease",
  () =>
    Effect.gen(function* () {
      const admission = yield* WorkAdmission.WorkAdmission;
      const reopened = yield* admission.reopened.pipe(
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      const held = yield* admission.acquire(leaseId, Effect.void);
      assert.equal(held.state, "held");
      assert.deepEqual(
        yield* admission.acquire(leaseId, Effect.die("idempotent acquire inspected again")),
        held,
      );
      assert.equal((yield* Effect.flip(admission.cancel(otherLeaseId))).reason, "lease_conflict");
      yield* TestClock.adjust("120 seconds");
      yield* Fiber.join(reopened);
      assert.equal((yield* admission.status).state, "open");
      assert.equal(yield* admission.run(Effect.succeed(1)), 1);
      yield* admission.acquire(otherLeaseId, Effect.void);
      assert.equal((yield* admission.cancel(otherLeaseId)).state, "open");
      assert.equal((yield* admission.cancel(otherLeaseId)).state, "open");
    }).pipe(Effect.provide(WorkAdmission.layer)),
);
