import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, ProviderDriverKind, type ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import * as Effect from "effect/Effect";

import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { queuedTurnInput } from "./fixtures/queued_turn/input.ts";
import { CODEX_MODEL_SELECTION, materializeFixtureInput } from "./fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import { layerProviderReplay } from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

const SCENARIO = "queued_turn";

/**
 * The recorded two-turn Codex session (a turn, then a message queued behind
 * it) with every queue paused: the second message waits after the first turn
 * ends, until the user starts it on purpose.
 */
const runWithQueuesPaused = Effect.fn("runWithQueuesPaused")(function* (targeted: boolean) {
  const recorded = yield* readProviderReplayTranscript(
    new URL(`./fixtures/${SCENARIO}/codex_transcript.ndjson`, import.meta.url),
  ).pipe(Effect.provide(NodeServices.layer));
  const workspace = yield* checkpointWorkspace(SCENARIO);
  const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
    materializeReplayTranscriptWorkspace(
      materializeReplayTranscriptRuntimeInstructions(recorded, {
        driver: ProviderDriverKind.make("codex"),
        model: CODEX_MODEL_SELECTION.model,
      }),
      workspace,
    ),
  );
  const materialized = yield* materializeFixtureInput({
    scenario: SCENARIO,
    fixtureInput: queuedTurnInput(),
    driver: ProviderDriverKind.make("codex"),
    modelSelection: CODEX_MODEL_SELECTION,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const threadId = materialized.projectionThreadIds[0] as ThreadId;
  const scenario = {
    name: `${SCENARIO}/queues-paused`,
    transcript,
    commands: materialized.commands,
    // A paused queue never lets the thread go idle, so wait on runs instead.
    steps: materialized.steps.filter((step) => step.type !== "await_thread_idle"),
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { cwd: workspace },
  };
  const awaitRun = (runId: string, status: "completed") =>
    runOrchestratorV2Scenario({
      ...scenario,
      steps: [{ type: "await_run_status", threadId, runId: runId as never, status }],
    });

  return yield* Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const runStatuses = () =>
      orchestrator
        .getThreadProjection(threadId)
        .pipe(Effect.map((projection) => projection.runs.map((run) => run.status)));

    yield* runOrchestratorV2Scenario(scenario);
    const [first, second] = (yield* orchestrator.getThreadProjection(threadId)).runs;
    assert.isDefined(first);
    assert.isDefined(second);
    yield* awaitRun(first!.id, "completed");
    yield* worker.drain();
    const afterFirstTurn = yield* runStatuses();

    // Resuming the thread's own queue does not lift the pause of all queues.
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("queue-pause:resume"),
      threadId,
    });
    yield* worker.drain();
    const afterPlainResume = yield* runStatuses();

    // "Send now" starts this thread's next message despite the pause.
    yield* orchestrator.dispatch(
      targeted
        ? {
            type: "queued-run.start",
            commandId: CommandId.make("queue-pause:send-selected"),
            threadId,
            runId: second!.id,
          }
        : {
            type: "queue.resume",
            commandId: CommandId.make("queue-pause:send-now"),
            threadId,
            startNextDespitePause: true,
          },
    );
    yield* awaitRun(second!.id, "completed");
    return { afterFirstTurn, afterPlainResume, afterSendNow: yield* runStatuses() };
  }).pipe(
    Effect.provide(
      layerProviderReplay(scenario, CodexOrchestratorReplayHarness, { threadQueuesPaused: true }),
    ),
  );
});

describe("pause of all queues", () => {
  it.effect.each([false, true])(
    "holds a queued message until explicit send (selected run: %s)",
    (targeted) =>
      Effect.scoped(
        Effect.gen(function* () {
          const statuses = yield* runWithQueuesPaused(targeted);
          assert.deepEqual(statuses.afterFirstTurn, ["completed", "queued"]);
          assert.deepEqual(statuses.afterPlainResume, ["completed", "queued"]);
          assert.deepEqual(statuses.afterSendNow, ["completed", "completed"]);
        }).pipe(provideDeterministicTestRuntime),
      ),
  );
});
