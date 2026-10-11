import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { instantFailureRetryCommand, isTransientStartFailure } from "./InstantFailureRetry.ts";

type Projection = Parameters<typeof instantFailureRetryCommand>[0];
type Run = OrchestrationV2ThreadProjection["runs"][number];
type Message = OrchestrationV2ThreadProjection["messages"][number];
type TurnItem = OrchestrationV2ThreadProjection["turnItems"][number];

const threadId = ThreadId.make("thread:retry");
const runId = RunId.make("run:1");
const instance = ProviderInstanceId.make("codex");
const at = (iso: string) => DateTime.makeUnsafe(iso);

// Only the fields the decision reads; the rest of the records do not matter here.
const run = (overrides: Partial<Run> = {}) =>
  ({
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instance,
    modelSelection: { instanceId: instance, model: "gpt-5.4" },
    userMessageId: MessageId.make("message:user"),
    status: "failed",
    requestedAt: at("2026-10-11T08:00:00.000Z"),
    startedAt: at("2026-10-11T08:00:01.000Z"),
    completedAt: at("2026-10-11T08:00:03.000Z"),
    ...overrides,
  }) as Run;

const userMessage = (overrides: Partial<Message> = {}) =>
  ({
    id: MessageId.make("message:user"),
    threadId,
    runId,
    role: "user",
    text: "Fix the build.",
    attachments: [],
    ...overrides,
  }) as Message;

const failure = (cls: string, message: string) =>
  ({ type: "error", runId, failure: { class: cls, message } }) as TurnItem;

const sessionDidNotOpen = failure(
  "provider_error",
  "Failed to open codex provider session provider-session:provider-instance:codex:shared.",
);

const projection = (overrides: Partial<Projection> = {}): Projection => ({
  thread: {
    id: threadId,
    archivedAt: null,
    deletedAt: null,
    providerInstanceId: instance,
  } as Projection["thread"],
  runs: [run()],
  messages: [userMessage()],
  turnItems: [sessionDidNotOpen],
  ...overrides,
});

describe("isTransientStartFailure", () => {
  it("accepts the start failures seen in practice", () => {
    expect(
      isTransientStartFailure({ class: "transport_error", message: "Provider turn failed." }),
    ).toBe(true);
    expect(
      isTransientStartFailure(
        sessionDidNotOpen.type === "error" ? sessionDidNotOpen.failure : never(),
      ),
    ).toBe(true);
    expect(
      isTransientStartFailure({
        class: "provider_error",
        message: "Codex App Server process exited with code 1",
      }),
    ).toBe(true);
  });

  it("rejects failures that would repeat", () => {
    expect(
      isTransientStartFailure({ class: "usage_limit", message: "Claude API rate limit reached." }),
    ).toBe(false);
    expect(
      isTransientStartFailure({
        class: "provider_error",
        message: "Insufficient context allowance for the provider handoff.",
      }),
    ).toBe(false);
    expect(isTransientStartFailure({ class: "permission_error", message: "Not signed in." })).toBe(
      false,
    );
  });
});

function never(): never {
  throw new Error("unreachable");
}

describe("instantFailureRetryCommand", () => {
  it("sends the same message again after a start failure", () => {
    const command = instantFailureRetryCommand(projection(), runId);
    expect(command).toMatchObject({
      type: "message.dispatch",
      threadId,
      text: "Fix the build.",
      messageId: "message:instant-retry:run:1",
      dispatchMode: { type: "queue_after_active" },
    });
  });

  it("retries once: a failed retry is reported", () => {
    const retryMessageId = MessageId.make("message:instant-retry:run:0");
    expect(
      instantFailureRetryCommand(
        projection({
          runs: [run({ userMessageId: retryMessageId })],
          messages: [userMessage({ id: retryMessageId })],
        }),
        runId,
      ),
    ).toBeNull();
  });

  it("leaves a turn alone that ran for a while or said something", () => {
    expect(
      instantFailureRetryCommand(
        projection({ runs: [run({ completedAt: at("2026-10-11T08:02:00.000Z") })] }),
        runId,
      ),
    ).toBeNull();
    expect(
      instantFailureRetryCommand(
        projection({
          messages: [
            userMessage(),
            userMessage({ id: MessageId.make("message:reply"), role: "assistant", text: "On it." }),
          ],
        }),
        runId,
      ),
    ).toBeNull();
  });

  it("does not retry a failure that would repeat", () => {
    expect(
      instantFailureRetryCommand(
        projection({ turnItems: [failure("usage_limit", "Claude API rate limit reached.")] }),
        runId,
      ),
    ).toBeNull();
    expect(instantFailureRetryCommand(projection({ turnItems: [] }), runId)).toBeNull();
  });

  it("steps aside when something newer ran in the thread", () => {
    const later = run({
      id: RunId.make("run:2"),
      ordinal: 2,
      status: "completed",
      completedAt: at("2026-10-11T08:00:30.000Z"),
    });
    expect(instantFailureRetryCommand(projection({ runs: [run(), later] }), runId)).toBeNull();
  });
});
