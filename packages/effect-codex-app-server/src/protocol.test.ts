import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import * as CodexRpc from "./rpc.ts";
import * as CodexSchema from "./schema.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const encoder = new TextEncoder();

const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeAccountTokenUsageResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/usage/read"],
);
const decodeAccountRateLimitsResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimits/read"],
);
const decodeConsumeRateLimitResetCreditParams = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_PARAMS["account/rateLimitResetCredit/consume"],
);
const decodeConsumeRateLimitResetCreditResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimitResetCredit/consume"],
);

const lineFramings = [
  { label: "LF", frame: (line: string) => [`${line}\n`] },
  { label: "CRLF", frame: (line: string) => [`${line}\r\n`] },
  { label: "CRLF split across chunks", frame: (line: string) => [`${line}\r`, "\n"] },
  { label: "CRLF split by an empty chunk", frame: (line: string) => [`${line}\r`, "", "\n"] },
];

// REMAINDER_BLOCK_LENGTH in protocol.ts: unfinished fragments shorter than this
// many UTF-16 code units are joined into one entry once they add up to it.
const remainderBlockLength = 1024;

// Text that differs by position, so a fragment kept out of order changes it.
const positionalText = (length: number) =>
  Array.from({ length }, (_, index) => index.toString(36))
    .join("")
    .slice(0, length);

const makeLimitedProtocol = (maxIncomingMessageBytes: number) =>
  Effect.gen(function* () {
    const { stdio, input, output } = yield* makeInMemoryStdio();
    const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
    const terminations: Array<CodexError.CodexAppServerError> = [];
    const notifications: Array<CodexProtocol.CodexAppServerIncomingNotification> = [];
    const events: Array<CodexProtocol.CodexAppServerProtocolLogEvent> = [];
    const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
      stdio,
      maxIncomingMessageBytes,
      logIncoming: true,
      logger: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      onNotification: (notification) =>
        Effect.sync(() => {
          notifications.push(notification);
        }),
      onTermination: (error) =>
        Effect.sync(() => terminations.push(error)).pipe(
          Effect.andThen(Deferred.succeed(termination, error)),
          Effect.asVoid,
        ),
    });
    return { input, output, transport, termination, terminations, notifications, events };
  });

const awaitMessageLimitFailure = (termination: Deferred.Deferred<CodexError.CodexAppServerError>) =>
  Effect.gen(function* () {
    const error = yield* Deferred.await(termination);
    assert.instanceOf(error, CodexError.CodexAppServerTransportError);
    assert.equal(error.operation, "read-input-stream");
    return error;
  });

it.layer(NodeServices.layer)("effect-codex-app-server protocol", (it) => {
  it.effect("maps account usage responses to the upstream token usage schema", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/usage/read"],
        CodexSchema.V2GetAccountTokenUsageResponse,
      );
      const decoded = yield* decodeAccountTokenUsageResponse({
        dailyUsageBuckets: [{ startDate: "2026-06-10", tokens: 42 }],
        summary: { lifetimeTokens: 42 },
      });
      assert.deepEqual(decoded, {
        dailyUsageBuckets: [{ startDate: "2026-06-10", tokens: 42 }],
        summary: { lifetimeTokens: 42 },
      });
    }),
  );

  it.effect("maps earned rate-limit reset credits from account rate-limit snapshots", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimits/read"],
        CodexSchema.V2GetAccountRateLimitsResponse,
      );

      const response = {
        rateLimits: {},
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            {
              id: "RateLimitResetCredit_1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_781_654_400,
              expiresAt: 1_784_246_400,
              title: "Full reset",
              description: "Ready to redeem",
            },
            {
              id: "RateLimitResetCredit_2",
              resetType: "unknown",
              status: "unknown",
              grantedAt: 1_781_654_401,
              expiresAt: null,
            },
          ],
        },
      } as const;

      assert.deepEqual(yield* decodeAccountRateLimitsResponse(response), response);
      assert.deepEqual(
        yield* decodeAccountRateLimitsResponse({
          rateLimits: {},
          rateLimitResetCredits: { availableCount: 2, credits: null },
        }),
        {
          rateLimits: {},
          rateLimitResetCredits: { availableCount: 2, credits: null },
        },
      );
    }),
  );

  it.effect("maps the earned rate-limit reset consume request and response", () =>
    Effect.gen(function* () {
      assert.equal(
        CodexRpc.CLIENT_REQUEST_METHODS["account/rateLimitResetCredit/consume"],
        "account/rateLimitResetCredit/consume",
      );
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_PARAMS["account/rateLimitResetCredit/consume"],
        CodexSchema.V2ConsumeAccountRateLimitResetCreditParams,
      );
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimitResetCredit/consume"],
        CodexSchema.V2ConsumeAccountRateLimitResetCreditResponse,
      );

      assert.deepEqual(
        yield* decodeConsumeRateLimitResetCreditParams({
          idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
          creditId: "RateLimitResetCredit_1",
        }),
        {
          idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
          creditId: "RateLimitResetCredit_1",
        },
      );
      assert.deepEqual(yield* decodeConsumeRateLimitResetCreditResponse({ outcome: "reset" }), {
        outcome: "reset",
      });
    }),
  );

  it.effect(
    "encodes requests without a jsonrpc field and routes inbound requests and notifications",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

        const notificationDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingNotification>>();
        const requestDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingRequest>>();

        yield* transport.incomingNotifications.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((notifications) => Deferred.succeed(notificationDeferred, notifications)),
          Effect.forkScoped,
        );

        yield* transport.incomingRequests.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((requests) => Deferred.succeed(requestDeferred, requests)),
          Effect.forkScoped,
        );

        yield* transport.notify("initialized");
        assert.equal(yield* Queue.take(output), '{"method":"initialized"}\n');

        const initializeParams = {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        };

        const pendingInitialize = yield* transport
          .request("initialize", initializeParams)
          .pipe(Effect.forkScoped);
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 1,
          method: "initialize",
          params: initializeParams,
        });

        yield* Queue.offer(
          input,
          encodeJsonl({
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 1,
            result: {
              userAgent: "mock-codex-app-server",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );

        assert.deepEqual(yield* Fiber.join(pendingInitialize), {
          userAgent: "mock-codex-app-server",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        });
        assert.deepEqual(yield* Deferred.await(notificationDeferred), [
          {
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        ]);
        assert.deepEqual(yield* Deferred.await(requestDeferred), [
          {
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          },
        ]);

        yield* transport.respond(77, {
          answers: {
            approved: {
              answers: ["yes"],
            },
          },
        });
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 77,
          result: {
            answers: {
              approved: {
                answers: ["yes"],
              },
            },
          },
        });

        yield* transport.respondError(
          78,
          CodexError.CodexAppServerRequestError.methodNotFound("x/test"),
        );
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 78,
          error: {
            code: -32601,
            message: "Method not found: x/test",
          },
        });
      }),
  );

  it.effect("routes a large notification fragmented across thousands of input chunks", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const notifications: Array<CodexProtocol.CodexAppServerIncomingNotification> = [];
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onNotification: (notification) =>
          Effect.sync(() => {
            notifications.push(notification);
          }),
      });
      const response = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);

      const notification = {
        method: "turn/diff/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          diff: "x".repeat(4 * 1024 * 1024),
        },
      };
      const bytes = encoder.encode(
        `${encodeUnknownJsonString(notification)}\n${encodeUnknownJsonString({ id: 1, result: { ok: true } })}\n`,
      );
      for (let offset = 0; offset < bytes.length; offset += 1024) {
        yield* Queue.offer(input, bytes.subarray(offset, offset + 1024));
      }

      assert.deepEqual(yield* Fiber.join(response), { ok: true });
      assert.deepEqual(notifications, [notification]);
    }),
  );

  it.effect.each(lineFramings)(
    "accepts a message exactly at the byte limit with $label framing",
    ({ frame }) =>
      Effect.gen(function* () {
        const message = { method: "x/limit", params: { text: "at the limit" } };
        const line = encodeUnknownJsonString(message);
        const { input, termination, notifications } = yield* makeLimitedProtocol(
          encoder.encode(line).length,
        );

        for (const chunk of frame(line)) {
          yield* Queue.offer(input, encoder.encode(chunk));
        }
        yield* Queue.end(input);

        assert.instanceOf(
          yield* Deferred.await(termination),
          CodexError.CodexAppServerInputStreamEndedError,
        );
        assert.deepEqual(notifications, [message]);
      }),
  );

  it.effect.each(lineFramings)(
    "rejects a message one byte over the limit with $label framing",
    ({ frame }) =>
      Effect.gen(function* () {
        const line = encodeUnknownJsonString({ method: "x/over", params: { text: "one over" } });
        const { input, output, transport, termination, terminations, notifications, events } =
          yield* makeLimitedProtocol(encoder.encode(line).length - 1);
        const pending = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
        yield* Queue.take(output);

        for (const chunk of frame(line)) {
          yield* Queue.offer(input, encoder.encode(chunk));
        }
        yield* Queue.end(input);

        const error = yield* awaitMessageLimitFailure(termination);
        const pendingError = yield* Fiber.join(pending).pipe(
          Effect.match({
            onFailure: (failure) => failure,
            onSuccess: () => assert.fail("Expected the oversized message to fail the request"),
          }),
        );
        assert.strictEqual(pendingError, error);
        assert.lengthOf(terminations, 1);
        assert.strictEqual(terminations[0], error);
        assert.deepEqual(notifications, []);
        assert.deepEqual(events, []);
      }),
  );

  it.effect("rejects an over-limit message from small fragments before its newline arrives", () =>
    Effect.gen(function* () {
      const { input, output, transport, termination, notifications, events } =
        yield* makeLimitedProtocol(1024);
      const pending = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);

      yield* Queue.offer(input, encoder.encode('{"method":"x/huge","params":{"text":"'));
      for (let index = 0; index < 512; index++) {
        yield* Queue.offer(input, encoder.encode("xxxxxxxx"));
      }

      const error = yield* awaitMessageLimitFailure(termination);
      const pendingError = yield* Fiber.join(pending).pipe(
        Effect.match({
          onFailure: (failure) => failure,
          onSuccess: () => assert.fail("Expected the oversized message to fail the request"),
        }),
      );
      assert.strictEqual(pendingError, error);
      assert.deepEqual(notifications, []);
      assert.deepEqual(events, []);
    }),
  );

  it.effect.each([
    { label: "LF after several blocks", length: 5 * remainderBlockLength + 300, terminator: "\n" },
    {
      label: "CRLF whose \\r completes a block",
      length: 4 * remainderBlockLength - 1,
      terminator: "\r\n",
    },
  ])(
    "routes a message sent one byte per chunk at the byte limit with $label",
    ({ length, terminator }) =>
      Effect.gen(function* () {
        const empty = encodeUnknownJsonString({ method: "x/bytes", params: { text: "" } });
        const message = {
          method: "x/bytes",
          params: { text: positionalText(length - empty.length) },
        };
        const line = encodeUnknownJsonString(message);
        assert.lengthOf(line, length);
        const { input, termination, notifications } = yield* makeLimitedProtocol(length);

        const bytes = encoder.encode(`${line}${terminator}`);
        for (let offset = 0; offset < bytes.length; offset++) {
          yield* Queue.offer(input, bytes.subarray(offset, offset + 1));
        }
        yield* Queue.end(input);

        assert.instanceOf(
          yield* Deferred.await(termination),
          CodexError.CodexAppServerInputStreamEndedError,
        );
        assert.deepEqual(notifications, [message]);
      }),
  );

  it.effect("keeps one-byte chunks in order around a chunk longer than a block", () =>
    Effect.gen(function* () {
      const message = {
        method: "x/mixed",
        params: { text: positionalText(4 * remainderBlockLength) },
      };
      const bytes = encodeJsonl(message);
      const { input, termination, notifications } = yield* makeLimitedProtocol(bytes.length - 1);

      const longEnd = 100 + 2 * remainderBlockLength;
      const chunks = [
        ...Array.from({ length: 100 }, (_, offset) => bytes.subarray(offset, offset + 1)),
        bytes.subarray(100, longEnd),
        ...Array.from({ length: 100 }, (_, index) =>
          bytes.subarray(longEnd + index, longEnd + index + 1),
        ),
        bytes.subarray(longEnd + 100),
      ];
      for (const chunk of chunks) {
        yield* Queue.offer(input, chunk);
      }
      yield* Queue.end(input);

      assert.instanceOf(
        yield* Deferred.await(termination),
        CodexError.CodexAppServerInputStreamEndedError,
      );
      assert.deepEqual(notifications, [message]);
    }),
  );

  it.effect(
    "rejects an over-limit message sent one byte per chunk before its newline arrives",
    () =>
      Effect.gen(function* () {
        const limit = 3 * remainderBlockLength + 5;
        const { input, output, transport, termination, notifications, events } =
          yield* makeLimitedProtocol(limit);
        const pending = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
        yield* Queue.take(output);

        const bytes = encoder.encode(`{"method":"x/huge","params":{"text":"${"x".repeat(limit)}`);
        for (let offset = 0; offset < bytes.length; offset++) {
          yield* Queue.offer(input, bytes.subarray(offset, offset + 1));
        }

        const error = yield* awaitMessageLimitFailure(termination);
        const pendingError = yield* Fiber.join(pending).pipe(
          Effect.match({
            onFailure: (failure) => failure,
            onSuccess: () => assert.fail("Expected the oversized message to fail the request"),
          }),
        );
        assert.strictEqual(pendingError, error);
        assert.deepEqual(notifications, []);
        assert.deepEqual(events, []);
      }),
  );

  it.effect.each([1, 7])(
    "keeps multi-byte characters intact across remainder blocks with %i-byte input chunks",
    (chunkSize) =>
      Effect.gen(function* () {
        const head = '{"method":"x/unicode","params":{"text":"';
        // The emoji's surrogate pair straddles the first block edge; 3-byte
        // characters fill the blocks after it.
        const text = `${"é".repeat(remainderBlockLength - 1 - head.length)}🙂${"最".repeat(3 * remainderBlockLength)}`;
        const message = { method: "x/unicode", params: { text } };
        const line = encodeUnknownJsonString(message);
        assert.strictEqual(line.indexOf("🙂"), remainderBlockLength - 1);
        const bytes = encoder.encode(`${line}\n`);
        const { input, termination, notifications } = yield* makeLimitedProtocol(bytes.length - 1);

        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          yield* Queue.offer(input, bytes.subarray(offset, offset + chunkSize));
        }
        yield* Queue.end(input);

        assert.instanceOf(
          yield* Deferred.await(termination),
          CodexError.CodexAppServerInputStreamEndedError,
        );
        assert.deepEqual(notifications, [message]);
      }),
  );

  it.effect.each([
    { label: "short", prefixLength: 64 },
    { label: "long", prefixLength: remainderBlockLength + 76 },
  ])(
    "routes a message with a $label first fragment after complete lines in a large chunk",
    ({ prefixLength }) =>
      Effect.gen(function* () {
        const before = { method: "x/before", params: { index: 1 } };
        const message = {
          method: "x/after",
          params: { text: `最🙂${positionalText(4 * remainderBlockLength)}` },
        };
        const line = encodeUnknownJsonString(message);
        const lineLimit = 64 * 1024;
        const { input, termination, notifications } = yield* makeLimitedProtocol(lineLimit);

        // Whitespace lines make the chunk far longer than the fragment kept from its end.
        const blankLines = `${" ".repeat(lineLimit)}\n`.repeat(16);
        yield* Queue.offer(
          input,
          encoder.encode(
            `${blankLines}${encodeUnknownJsonString(before)}\n${line.slice(0, prefixLength)}`,
          ),
        );
        yield* Queue.offer(input, encoder.encode(`${line.slice(prefixLength)}\n`));
        yield* Queue.end(input);

        assert.instanceOf(
          yield* Deferred.await(termination),
          CodexError.CodexAppServerInputStreamEndedError,
        );
        assert.deepEqual(notifications, [before, message]);
      }),
  );

  it.effect("routes an unterminated final message at the byte limit when input ends", () =>
    Effect.gen(function* () {
      const message = { method: "x/final", params: { text: "no newline" } };
      const line = encodeUnknownJsonString(message);
      const { input, termination, notifications } = yield* makeLimitedProtocol(
        encoder.encode(line).length,
      );

      yield* Queue.offer(input, encoder.encode(line));
      yield* Queue.end(input);

      assert.instanceOf(
        yield* Deferred.await(termination),
        CodexError.CodexAppServerInputStreamEndedError,
      );
      assert.deepEqual(notifications, [message]);
    }),
  );

  it.effect.each([
    { label: "an unterminated final message", suffix: "" },
    { label: "a final message ending in a bare \\r", suffix: "\r" },
  ])("rejects $label one byte over the limit when input ends", ({ suffix }) =>
    Effect.gen(function* () {
      const line = encodeUnknownJsonString({ method: "x/final", params: { text: "no newline" } });
      const { input, termination, notifications, events } = yield* makeLimitedProtocol(
        encoder.encode(line).length + suffix.length - 1,
      );

      yield* Queue.offer(input, encoder.encode(`${line}${suffix}`));
      yield* Queue.end(input);

      yield* awaitMessageLimitFailure(termination);
      assert.deepEqual(notifications, []);
      assert.deepEqual(events, []);
    }),
  );

  it.effect.each([1, 7])(
    "counts UTF-8 bytes of characters split across %i-byte input chunks",
    (chunkSize) =>
      Effect.gen(function* () {
        const message = { method: "x/unicode", params: { text: "最後🙂🙂最後" } };
        const line = encodeUnknownJsonString(message);
        const bytes = encoder.encode(`${line}\n`);
        const lineBytes = bytes.length - 1;
        // Counting UTF-16 code units instead of bytes would accept the over-limit message.
        assert.isBelow(line.length, lineBytes - 1);

        const atLimit = yield* makeLimitedProtocol(lineBytes);
        const overLimit = yield* makeLimitedProtocol(lineBytes - 1);
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          yield* Queue.offer(atLimit.input, bytes.subarray(offset, offset + chunkSize));
          yield* Queue.offer(overLimit.input, bytes.subarray(offset, offset + chunkSize));
        }
        yield* Queue.end(atLimit.input);
        yield* Queue.end(overLimit.input);

        assert.instanceOf(
          yield* Deferred.await(atLimit.termination),
          CodexError.CodexAppServerInputStreamEndedError,
        );
        assert.deepEqual(atLimit.notifications, [message]);
        yield* awaitMessageLimitFailure(overLimit.termination);
        assert.deepEqual(overLimit.notifications, []);
        assert.deepEqual(overLimit.events, []);
      }),
  );

  it.effect("keeps an over-limit message out of protocol logs and the termination error", () =>
    Effect.gen(function* () {
      const secret = "codex-oversized-secret-sentinel";
      const small = { method: "x/small", params: {} };
      const { input, termination, notifications, events } = yield* makeLimitedProtocol(64);

      yield* Queue.offer(input, encodeJsonl(small));
      yield* Queue.offer(input, encodeJsonl({ method: "x/huge", params: { text: secret } }));
      yield* Queue.end(input);

      const error = yield* awaitMessageLimitFailure(termination);
      assert.deepEqual(notifications, [small]);
      assert.deepEqual(
        events.map(({ stage }) => stage),
        ["raw", "decoded"],
      );
      assert.notInclude(encodeUnknownJsonString(events), secret);
      assert.notInclude(error.message, secret);
      assert.notInclude(String(error.cause), secret);
    }),
  );

  it.effect.each([
    { label: "a terminated", newline: "\n" },
    { label: "an unterminated", newline: "" },
  ])("dispatches complete lines that precede $label over-limit line in one chunk", ({ newline }) =>
    Effect.gen(function* () {
      const first = { method: "x/first", params: { index: 1 } };
      const second = { method: "x/second", params: { index: 2 } };
      const oversized = { method: "x/huge", params: { text: "y".repeat(64) } };
      const { input, termination, notifications } = yield* makeLimitedProtocol(64);

      yield* Queue.offer(
        input,
        encoder.encode(
          `${[first, second, oversized].map((message) => encodeUnknownJsonString(message)).join("\n")}${newline}`,
        ),
      );
      yield* Queue.end(input);

      yield* awaitMessageLimitFailure(termination);
      assert.deepEqual(notifications, [first, second]);
    }),
  );

  it.effect.each([1, 7, 1024])(
    "preserves JSONL framing and UTF-8 across %i-byte input chunks",
    (chunkSize) =>
      Effect.gen(function* () {
        const { stdio, input } = yield* makeInMemoryStdio();
        const notifications: Array<CodexProtocol.CodexAppServerIncomingNotification> = [];
        const rawLines: Array<unknown> = [];
        const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
        yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
          stdio,
          logIncoming: true,
          logger: (event) =>
            Effect.sync(() => {
              if (event.stage === "raw") {
                rawLines.push(event.payload);
              }
            }),
          onNotification: (notification) =>
            Effect.sync(() => {
              notifications.push(notification);
            }),
          onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
        });

        const firstLine = '{"method":"x/first",\r"params":{"text":"hé🙂"}}';
        const secondLine = '{"method":"x/second","params":{"value":2}}';
        const finalLine = '{"method":"x/final","params":{"text":"最後"}}\r';
        const bytes = encoder.encode(`\n \t\r\n${firstLine}\r\n\n${secondLine}\n${finalLine}`);
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          yield* Queue.offer(input, bytes.subarray(offset, offset + chunkSize));
        }
        yield* Queue.end(input);

        assert.instanceOf(
          yield* Deferred.await(termination),
          CodexError.CodexAppServerInputStreamEndedError,
        );
        assert.deepEqual(notifications, [
          { method: "x/first", params: { text: "hé🙂" } },
          { method: "x/second", params: { value: 2 } },
          { method: "x/final", params: { text: "最後" } },
        ]);
        assert.deepEqual(rawLines, [firstLine, secondLine, finalLine]);
      }),
  );

  it.effect("reports a malformed fragmented final line before input stream termination", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });
      const response = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);

      yield* Queue.offer(input, encoder.encode('{"id":1,'));
      yield* Queue.offer(input, encoder.encode('"result":'));
      yield* Queue.end(input);

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, CodexError.CodexAppServerProtocolParseError);
      assert.equal(error.operation, "decode-wire-message");
      const responseError = yield* Fiber.join(response).pipe(
        Effect.match({
          onFailure: (failure) => failure,
          onSuccess: () => assert.fail("Expected the malformed response to fail the request"),
        }),
      );
      assert.strictEqual(responseError, error);
    }),
  );

  it.effect("keeps only recent raw notifications after their callbacks run", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Deferred.make<void>();
      let handledCount = 0;
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onNotification: () =>
          Effect.sync(() => ++handledCount).pipe(
            Effect.flatMap((count) =>
              count === 64 ? Deferred.succeed(handled, undefined).pipe(Effect.asVoid) : Effect.void,
            ),
          ),
      });

      const messages = Array.from({ length: 64 }, (_, index) =>
        encodeUnknownJsonString({
          method: "item/agentMessage/delta",
          params: { index },
        }),
      );
      yield* Queue.offer(input, encoder.encode(`${messages.join("\n")}\n`));
      yield* Deferred.await(handled);

      const retained = yield* transport.incomingNotifications.pipe(
        Stream.take(32),
        Stream.runCollect,
      );

      assert.equal(handledCount, 64);
      assert.equal(retained.length, 32);
      assert.deepEqual(retained[0]?.params, { index: 32 });
      assert.deepEqual(retained[31]?.params, { index: 63 });
    }),
  );

  it.effect("keeps processing protocol messages while an approval is pending", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const approvalStarted = yield* Deferred.make<void>();
      const approvalDecision = yield* Deferred.make<{ readonly decision: string }>();
      const notificationReceived = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () =>
          Deferred.succeed(approvalStarted, undefined).pipe(
            Effect.andThen(Deferred.await(approvalDecision)),
          ),
        onNotification: () => Deferred.succeed(notificationReceived, undefined).pipe(Effect.asVoid),
      });

      const pendingRequest = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(
        input,
        encoder.encode(
          `${[
            encodeUnknownJsonString({ id: 7, method: "item/tool/requestUserInput", params: {} }),
            encodeUnknownJsonString({ method: "item/agentMessage/delta", params: { delta: "ok" } }),
            encodeUnknownJsonString({ id: 1, result: { threadId: "thread-1" } }),
          ].join("\n")}\n`,
        ),
      );

      yield* Deferred.await(approvalStarted);
      yield* Deferred.await(notificationReceived);
      assert.deepEqual(yield* Fiber.join(pendingRequest), { threadId: "thread-1" });

      yield* Deferred.succeed(approvalDecision, { decision: "accept" });
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 7,
        result: { decision: "accept" },
      });
    }),
  );

  it.effect("rejects incoming requests after the active handler limit is reached", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const handlersStarted = yield* Deferred.make<void>();
      const releaseHandlers = yield* Deferred.make<void>();
      let activeHandlers = 0;
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () =>
          Effect.sync(() => ++activeHandlers).pipe(
            Effect.flatMap((count) =>
              count === 32
                ? Deferred.succeed(handlersStarted, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.andThen(Deferred.await(releaseHandlers)),
            Effect.as({ decision: "accept" }),
          ),
      });

      const requests = Array.from({ length: 33 }, (_, index) =>
        encodeUnknownJsonString({
          id: index + 1,
          method: "item/tool/requestUserInput",
          params: {},
        }),
      );
      yield* Queue.offer(input, encoder.encode(`${requests.join("\n")}\n`));
      yield* Deferred.await(handlersStarted);

      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 33,
        error: {
          code: -32001,
          message: "Too many Codex requests are already active.",
        },
      });
      assert.equal(activeHandlers, 32);

      yield* Deferred.succeed(releaseHandlers, undefined);
      yield* Effect.forEach(Array.from({ length: 32 }), () => Queue.take(output), {
        discard: true,
      });
    }),
  );

  it.effect("interrupts pending request handlers when the protocol terminates", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const approvalStarted = yield* Deferred.make<void>();
      const approvalInterrupted = yield* Deferred.make<void>();
      const terminated = yield* Deferred.make<void>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () =>
          Deferred.succeed(approvalStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Deferred.succeed(approvalInterrupted, undefined).pipe(Effect.asVoid),
            ),
          ),
        onTermination: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        encodeJsonl({ id: 7, method: "item/tool/requestUserInput", params: {} }),
      );
      yield* Deferred.await(approvalStarted);
      yield* Queue.end(input);

      yield* Deferred.await(approvalInterrupted);
      yield* Deferred.await(terminated);
    }),
  );

  it.effect("rejects outgoing messages after an approval response cannot be encoded", () =>
    Effect.gen(function* () {
      const { stdio: baseStdio, input } = yield* makeInMemoryStdio();
      const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
      const readerStopped = yield* Deferred.make<void>();
      let notificationCount = 0;
      let requestCount = 0;
      const stdio = Stdio.make({
        args: baseStdio.args,
        stdin: baseStdio.stdin.pipe(
          Stream.ensuring(Deferred.succeed(readerStopped, undefined).pipe(Effect.asVoid)),
        ),
        stdout: baseStdio.stdout,
        stderr: baseStdio.stderr,
      });
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () =>
          Effect.sync(() => ++requestCount).pipe(
            Effect.map((count) => (count === 1 ? { invalid: 1n } : { ok: true })),
          ),
        onNotification: () => Effect.sync(() => notificationCount++).pipe(Effect.asVoid),
        onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        encodeJsonl({ id: 7, method: "item/tool/requestUserInput", params: {} }),
      );

      const failure = yield* Deferred.await(terminated);
      assert.instanceOf(failure, CodexError.CodexAppServerProtocolParseError);
      const requestFailure = yield* transport.request("thread/read", {}).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected a terminated protocol request to fail"),
        }),
      );
      const notificationFailure = yield* transport.notify("initialized").pipe(Effect.flip);
      assert.strictEqual(requestFailure, failure);
      assert.strictEqual(notificationFailure, failure);
      yield* Deferred.await(readerStopped);

      yield* Queue.offer(
        input,
        encoder.encode(
          `${[
            encodeUnknownJsonString({ method: "x/late-notification" }),
            encodeUnknownJsonString({ id: 8, method: "x/late-request" }),
          ].join("\n")}\n`,
        ),
      );

      assert.equal(notificationCount, 0);
      assert.equal(requestCount, 1);
      assert.equal(yield* Queue.size(input), 1);
    }),
  );

  it.effect("fails pending requests before interrupted handler cleanup completes", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const handlerStarted = yield* Deferred.make<void>();
      const finalizerStarted = yield* Deferred.make<void>();
      const releaseFinalizer = yield* Deferred.make<void>();
      const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () =>
          Deferred.succeed(handlerStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Deferred.succeed(finalizerStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFinalizer)),
              ),
            ),
          ),
        onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
      });
      const pending = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(input, encodeJsonl({ id: 7, method: "x/approval" }));
      yield* Deferred.await(handlerStarted);
      yield* Queue.end(input);

      const failure = yield* Deferred.await(terminated);
      yield* Deferred.await(finalizerStarted);
      const pendingFailure = yield* Fiber.join(pending).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected the pending request to fail"),
        }),
      );
      assert.strictEqual(pendingFailure, failure);

      yield* Deferred.succeed(releaseFinalizer, undefined);
    }),
  );

  it.effect("surfaces JSON encoding failures as protocol parse errors", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(bigintError.operation, "encode-wire-message");
      assert.equal(bigintError.method, "x/test");
      assert.exists(bigintError.cause);
      assert.equal(
        bigintError.message,
        "Codex App Server protocol operation 'encode-wire-message' failed for method 'x/test'.",
      );

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(circularError.operation, "encode-wire-message");
      assert.equal(circularError.method, "x/test");
      assert.exists(circularError.cause);

      const requestError = yield* transport.request("x/request", 1n).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected request encoding to fail"),
        }),
      );
      assert.instanceOf(requestError, CodexError.CodexAppServerProtocolParseError);
      assert.deepInclude(requestError, {
        operation: "encode-wire-message",
        method: "x/request",
        requestId: "1",
      });
    }),
  );

  it.effect("correlates response errors with the originating request", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const response = yield* transport.request("thread/start", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 1,
          error: {
            code: -32602,
            message: "Invalid params",
            data: { field: "cwd" },
          },
        }),
      );

      const error = yield* Fiber.join(response).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected Codex App Server request to fail"),
        }),
      );
      assert.instanceOf(error, CodexError.CodexAppServerRequestError);
      assert.deepInclude(error, {
        code: -32602,
        errorMessage: "Invalid params",
        method: "thread/start",
        requestId: "1",
        operation: "receive-response",
      });
    }),
  );

  it.effect("logs decode failures without copying the cause or wire payload", () =>
    Effect.gen(function* () {
      const secret = "codex-wire-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const events: Array<CodexProtocol.CodexAppServerProtocolLogEvent> = [];
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        logIncoming: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(input, encoder.encode(`{"secret":"${secret}"\n`));
      yield* Deferred.await(termination);

      const event = events.find(({ stage }) => stage === "decode_failed");
      assert.exists(event);
      assert.equal(event.direction, "incoming");
      const payload = event.payload as Record<string, unknown>;
      assert.equal(payload.operation, "decode-wire-message");
      assert.isNumber(payload.issueCount);
      assert.isArray(payload.issueKinds);
      assert.isNumber(payload.maximumPathDepth);
      assert.equal("cause" in payload, false);
      assert.equal("detail" in payload, false);
      assert.notInclude(encodeUnknownJsonString(event), secret);
    }),
  );

  it.effect("describes unroutable messages with safe structural diagnostics", () =>
    Effect.gen(function* () {
      const secret = "codex-unroutable-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        encodeJsonl({ id: true, method: "thread/start", params: { token: secret } }),
      );

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, CodexError.CodexAppServerProtocolParseError);
      assert.deepInclude(error, {
        operation: "route-wire-message",
        method: "thread/start",
        payloadKind: "object",
        presentFields: ["id", "method", "params"],
      });
      assert.isUndefined(error.requestId);
      assert.notProperty(error, "detail");
      assert.notProperty(error, "cause");
      assert.notInclude(error.message, secret);
    }),
  );

  it.effect("classifies an input stream ending without inventing a cause", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.end(input);

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, CodexError.CodexAppServerInputStreamEndedError);
      assert.equal(error.message, "Codex App Server input stream ended.");
      assert.equal("cause" in error, false);
    }),
  );
});
