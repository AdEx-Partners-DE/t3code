import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as CodexError from "./errors.ts";
import { JsonRpcId, JsonRpcResponseEnvelope } from "./_internal/shared.ts";
const isJsonRpcId = Schema.is(JsonRpcId);
const isJsonRpcResponseEnvelope = Schema.is(JsonRpcResponseEnvelope);
const isCodexAppServerError = Schema.is(CodexError.CodexAppServerError);
const MAX_BUFFERED_RAW_MESSAGES = 32;
// Largest incoming JSONL message, in UTF-8 bytes without its line terminator.
// Codex diffs reach ~49M characters and grow when JSON-escaped; a line far
// past this ceiling would exhaust the heap during join and parse.
const MAX_INCOMING_MESSAGE_BYTES = 128 * 1024 * 1024;
// Unfinished-message fragments shorter than this many UTF-16 code units are
// joined into one entry once they add up to it, so a peer that sends one byte
// per read holds one entry per block rather than one per byte. Longer reads,
// such as 64 KiB pipe reads, are kept as they are without a copy.
const REMAINDER_BLOCK_LENGTH = 1024;

// UTF-8 size of `text.slice(start, end)` without encoding a copy. Text from a
// streaming TextDecoder holds no lone surrogates, so each surrogate is one half
// of a four-byte sequence.
const utf8ByteLength = (text: string, start: number, end: number) => {
  let bytes = 0;
  for (let index = start; index < end; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) bytes += 2;
    else bytes += 3;
  }
  return bytes;
};

export interface CodexAppServerProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export interface CodexAppServerIncomingNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerIncomingRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerPatchedProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<CodexError.CodexAppServerError>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly maxIncomingMessageBytes?: number;
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: CodexAppServerIncomingNotification,
  ) => Effect.Effect<void, never>;
  readonly onRequest?: (
    request: CodexAppServerIncomingRequest,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly onTermination?: (error: CodexError.CodexAppServerError) => Effect.Effect<void, never>;
}

export interface CodexAppServerPatchedProtocol {
  readonly incomingNotifications: Stream.Stream<CodexAppServerIncomingNotification>;
  readonly incomingRequests: Stream.Stream<CodexAppServerIncomingRequest>;
  readonly request: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly notify: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respond: (
    requestId: string | number,
    result: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respondError: (
    requestId: string | number,
    error: CodexError.CodexAppServerRequestError,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
}

interface CodexAppServerPendingRequest {
  readonly deferred: Deferred.Deferred<unknown, CodexError.CodexAppServerError>;
  readonly method: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIncomingRequest(value: unknown): value is CodexAppServerIncomingRequest {
  if (!isObject(value) || typeof value.method !== "string") {
    return false;
  }
  return isJsonRpcId(value.id);
}

function isIncomingNotification(value: unknown): value is CodexAppServerIncomingNotification {
  return isObject(value) && typeof value.method === "string" && !("id" in value);
}

function isIncomingResponse(value: unknown): value is typeof JsonRpcResponseEnvelope.Type {
  return isJsonRpcResponseEnvelope(value);
}

const encodeJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const encodeWireMessage = (
  message: Record<string, unknown>,
): Effect.Effect<string, CodexError.CodexAppServerProtocolParseError> =>
  encodeJsonString(message).pipe(
    Effect.map((encoded) => `${encoded}\n`),
    Effect.mapError((cause) => {
      const method = typeof message.method === "string" ? message.method : undefined;
      const requestId =
        typeof message.id === "string" || typeof message.id === "number"
          ? String(message.id)
          : undefined;
      return CodexError.CodexAppServerProtocolParseError.fromSchemaError(
        "encode-wire-message",
        cause,
        {
          ...(method === undefined ? {} : { method }),
          ...(requestId === undefined ? {} : { requestId }),
        },
      );
    }),
  );

const decodeWireMessage = (
  line: string,
): Effect.Effect<unknown, CodexError.CodexAppServerProtocolParseError> =>
  decodeJsonString(line).pipe(
    Effect.mapError((cause) =>
      CodexError.CodexAppServerProtocolParseError.fromSchemaError("decode-wire-message", cause),
    ),
  );

const normalizeIncomingError = (
  error: unknown,
  operation: CodexError.CodexAppServerTransportOperation,
): CodexError.CodexAppServerError =>
  isCodexAppServerError(error)
    ? error
    : new CodexError.CodexAppServerTransportError({
        operation,
        cause: error,
      });

const toProtocolMessage = (
  requestId: string | number,
  fields: {
    readonly result?: unknown;
    readonly error?: CodexError.CodexAppServerProtocolErrorShape;
  },
): { readonly [key: string]: unknown } => ({
  id: requestId,
  ...(fields.result !== undefined ? { result: fields.result } : {}),
  ...(fields.error !== undefined ? { error: fields.error } : {}),
});

export const makeCodexAppServerPatchedProtocol = Effect.fn("makeCodexAppServerPatchedProtocol")(
  function* (
    options: CodexAppServerPatchedProtocolOptions,
  ): Effect.fn.Return<CodexAppServerPatchedProtocol, never, Scope.Scope> {
    const protocolScope = yield* Scope.Scope;
    const requestHandlerScope = yield* Scope.fork(protocolScope, "parallel");
    const outgoing = yield* Queue.unbounded<string, Cause.Done<void>>();
    const incomingNotifications =
      yield* Queue.sliding<CodexAppServerIncomingNotification>(MAX_BUFFERED_RAW_MESSAGES);
    const incomingRequests =
      yield* Queue.sliding<CodexAppServerIncomingRequest>(MAX_BUFFERED_RAW_MESSAGES);
    const pending = yield* Ref.make(new Map<string, CodexAppServerPendingRequest>());
    const nextRequestId = yield* Ref.make(1);
    const maxIncomingMessageBytes = options.maxIncomingMessageBytes ?? MAX_INCOMING_MESSAGE_BYTES;
    const remainder: Array<string> = [];
    const remainderTail: Array<string> = [];
    let remainderTailLength = 0;
    let remainderBytes = 0;
    const terminationHandled = yield* Ref.make(false);
    const terminationFailure = yield* Ref.make(Option.none<CodexError.CodexAppServerError>());
    const terminationSignal = yield* Deferred.make<void>();
    const activeRequestHandlers = yield* Ref.make(0);

    const logProtocol = (event: CodexAppServerProtocolLogEvent) => {
      if (event.direction === "incoming" && !options.logIncoming) {
        return Effect.void;
      }
      if (event.direction === "outgoing" && !options.logOutgoing) {
        return Effect.void;
      }
      return (
        options.logger?.(event) ??
        Effect.logDebug("Codex App Server protocol event").pipe(Effect.annotateLogs({ event }))
      );
    };

    const failAllPending = (error: CodexError.CodexAppServerError) =>
      Ref.get(pending).pipe(
        Effect.flatMap((current) =>
          Effect.forEach([...current.values()], ({ deferred }) => Deferred.fail(deferred, error), {
            discard: true,
          }),
        ),
        Effect.andThen(Ref.set(pending, new Map())),
      );

    const handleTermination = (classify: () => Effect.Effect<CodexError.CodexAppServerError>) =>
      Ref.modify(terminationHandled, (handled) => {
        if (handled) {
          return [Effect.void, true] as const;
        }
        return [
          Effect.gen(function* () {
            const error = yield* classify();
            yield* Ref.set(terminationFailure, Option.some(error));
            yield* failAllPending(error);
            yield* Queue.end(outgoing);
            yield* Deferred.succeed(terminationSignal, undefined);
            yield* Scope.close(requestHandlerScope, Exit.void).pipe(
              Effect.forkIn(protocolScope, { startImmediately: true }),
              Effect.asVoid,
            );
            if (options.onTermination) {
              yield* options.onTermination(error);
            }
          }),
          true,
        ] as const;
      }).pipe(Effect.flatten);

    const offerOutgoing = (message: Record<string, unknown>) =>
      Effect.gen(function* () {
        const failure = yield* Ref.get(terminationFailure);
        if (Option.isSome(failure)) return yield* failure.value;

        yield* logProtocol({
          direction: "outgoing",
          stage: "decoded",
          payload: message,
        });
        const encoded = yield* encodeWireMessage(message);
        yield* logProtocol({
          direction: "outgoing",
          stage: "raw",
          payload: encoded,
        });
        const accepted = yield* Queue.offer(outgoing, encoded);
        if (!accepted) {
          const closed = yield* Ref.get(terminationFailure);
          return yield* Option.getOrElse(
            closed,
            () => new CodexError.CodexAppServerInputStreamEndedError({}),
          );
        }
      });

    const removePending = (requestId: string) =>
      Ref.update(pending, (current) => {
        if (!current.has(requestId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(requestId);
        return next;
      });

    const resolvePending = (
      requestId: string,
      handler: (pendingRequest: CodexAppServerPendingRequest) => Effect.Effect<void>,
    ) =>
      Ref.modify(pending, (current) => {
        const pendingRequest = current.get(requestId);
        if (!pendingRequest) {
          return [Effect.void, current] as const;
        }
        const next = new Map(current);
        next.delete(requestId);
        return [handler(pendingRequest), next] as const;
      }).pipe(Effect.flatten);

    const respond = (requestId: string | number, result: unknown) =>
      offerOutgoing(toProtocolMessage(requestId, { result }));

    const respondError = (
      requestId: string | number,
      error: CodexError.CodexAppServerRequestError,
    ) => offerOutgoing(toProtocolMessage(requestId, { error: error.toProtocolError() }));

    const handleResponse = (response: typeof JsonRpcResponseEnvelope.Type) => {
      const requestId = String(response.id);
      const protocolError = response.error;
      if (protocolError !== undefined) {
        return resolvePending(requestId, ({ deferred, method }) =>
          Deferred.fail(
            deferred,
            CodexError.CodexAppServerRequestError.fromProtocolError(
              protocolError,
              method,
              requestId,
            ),
          ),
        );
      }
      return resolvePending(requestId, ({ deferred }) =>
        Deferred.succeed(deferred, response.result),
      );
    };

    const handleRequest = (request: CodexAppServerIncomingRequest) =>
      Queue.offer(incomingRequests, request).pipe(
        Effect.flatMap(() => {
          const handler = options.onRequest;
          if (!handler) return Effect.void;

          return Ref.modify(activeRequestHandlers, (count) =>
            count >= MAX_BUFFERED_RAW_MESSAGES ? [false, count] : [true, count + 1],
          ).pipe(
            Effect.flatMap((accepted) => {
              if (!accepted) {
                return respondError(
                  request.id,
                  CodexError.CodexAppServerRequestError.overloaded(
                    "Too many Codex requests are already active.",
                  ),
                );
              }

              return handler(request).pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    respondError(
                      request.id,
                      CodexError.CodexAppServerRequestError.fromAppServerError(
                        error,
                        request.method,
                      ),
                    ),
                  onSuccess: (result) => respond(request.id, result),
                }),
                Effect.ensuring(
                  Ref.update(activeRequestHandlers, (count) => Math.max(0, count - 1)),
                ),
                Effect.catch((error) =>
                  handleTermination(() => Effect.succeed(error)).pipe(
                    Effect.forkIn(protocolScope),
                    Effect.asVoid,
                  ),
                ),
                Effect.forkIn(requestHandlerScope, { startImmediately: true }),
                Effect.asVoid,
              );
            }),
          );
        }),
        Effect.asVoid,
      );

    const handleNotification = (notification: CodexAppServerIncomingNotification) =>
      Queue.offer(incomingNotifications, notification).pipe(
        Effect.andThen(options.onNotification ? options.onNotification(notification) : Effect.void),
        Effect.asVoid,
      );

    const routeMessage = Effect.fnUntraced(function* (message: unknown) {
      if (Option.isSome(yield* Ref.get(terminationFailure))) return;
      if (isIncomingRequest(message)) return yield* handleRequest(message);
      if (isIncomingNotification(message)) return yield* handleNotification(message);
      if (isIncomingResponse(message)) return yield* handleResponse(message);
      return yield* CodexError.CodexAppServerProtocolParseError.fromUnroutableMessage(message);
    });

    const handleLine = (line: string): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (line.trim().length === 0) {
        return Effect.void;
      }
      return logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: line,
      }).pipe(
        Effect.flatMap(() => decodeWireMessage(line)),
        Effect.tap((decoded) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: decoded,
          }),
        ),
        Effect.tapErrorTag("CodexAppServerProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              operation: error.operation,
              ...(error.method === undefined ? {} : { method: error.method }),
              ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
              ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
              ...(error.issueKinds === undefined ? {} : { issueKinds: error.issueKinds }),
              ...(error.maximumPathDepth === undefined
                ? {}
                : { maximumPathDepth: error.maximumPathDepth }),
            },
          }),
        ),
        Effect.flatMap(routeMessage),
      );
    };

    // Fragments shorter than a block wait in the tail, which stays under a block
    // of code units and so under that many entries. Packing joins the tail into
    // one remainder entry, so a short fragment is copied here and once more when
    // its line is joined, never again.
    const packRemainderTail = () => {
      if (remainderTail.length > 0) {
        remainder.push(remainderTail.join(""));
        remainderTail.length = 0;
        remainderTailLength = 0;
      }
    };
    const retainFragment = (fragment: string) => {
      if (fragment.length >= REMAINDER_BLOCK_LENGTH) {
        packRemainderTail();
        remainder.push(fragment);
        return;
      }
      remainderTail.push(fragment);
      remainderTailLength += fragment.length;
      if (remainderTailLength >= REMAINDER_BLOCK_LENGTH) {
        packRemainderTail();
      }
    };
    const clearRemainder = () => {
      remainder.length = 0;
      remainderTail.length = 0;
      remainderTailLength = 0;
      remainderBytes = 0;
    };

    yield* options.stdio.stdin.pipe(
      Stream.interruptWhen(Deferred.await(terminationSignal)),
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          const lines: Array<string> = [];
          let start = 0;
          while (start < chunk.length) {
            const newline = chunk.indexOf("\n", start);
            const end = newline === -1 ? chunk.length : newline;
            const bytes = remainderBytes + utf8ByteLength(chunk, start, end);
            // A \r ending the fragment may be half of a CRLF terminator, so it does
            // not count yet. An empty fragment adds nothing to a remainder that fits.
            const overLimit =
              end > start &&
              bytes - (chunk.charCodeAt(end - 1) === 0x0d ? 1 : 0) > maxIncomingMessageBytes;
            if (overLimit) {
              clearRemainder();
              // Complete lines from earlier in this chunk are still handled, in order.
              return Effect.forEach(lines, handleLine, { discard: true }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new CodexError.CodexAppServerTransportError({
                      operation: "read-input-stream",
                      cause: new Error(
                        `Incoming message reached ${bytes} bytes, over the ${maxIncomingMessageBytes}-byte limit.`,
                      ),
                    }),
                  ),
                ),
              );
            }
            if (newline === -1) {
              // Keep unfinished lines in fragments so each chunk is scanned only once.
              retainFragment(chunk.slice(start));
              remainderBytes = bytes;
              break;
            }
            packRemainderTail();
            remainder.push(chunk.slice(start, newline));
            lines.push(remainder.join("").replace(/\r$/, ""));
            clearRemainder();
            start = newline + 1;
          }
          return Effect.forEach(lines, handleLine, { discard: true });
        }),
      ),
      Effect.matchEffect({
        onFailure: (error) =>
          handleTermination(() =>
            Effect.succeed(normalizeIncomingError(error, "read-input-stream")),
          ),
        onSuccess: () =>
          Effect.suspend(() => {
            // With no terminator left to strip, a final \r counts toward the limit.
            if (remainderBytes > maxIncomingMessageBytes) {
              const error = new CodexError.CodexAppServerTransportError({
                operation: "read-input-stream",
                cause: new Error(
                  `Incoming message reached ${remainderBytes} bytes, over the ${maxIncomingMessageBytes}-byte limit.`,
                ),
              });
              clearRemainder();
              return Effect.fail(error);
            }
            packRemainderTail();
            const line = remainder.join("");
            clearRemainder();
            return handleLine(line);
          }).pipe(
            Effect.matchEffect({
              onFailure: (error) => handleTermination(() => Effect.succeed(error)),
              onSuccess: () =>
                handleTermination(
                  () =>
                    options.terminationError ??
                    Effect.succeed(new CodexError.CodexAppServerInputStreamEndedError({})),
                ),
            }),
          ),
      }),
      Effect.forkScoped,
    );

    yield* Stream.fromQueue(outgoing).pipe(Stream.run(options.stdio.stdout()), Effect.forkScoped);

    const request = (method: string, payload?: unknown) =>
      Effect.gen(function* () {
        const requestId = yield* Ref.modify(
          nextRequestId,
          (current) => [current, current + 1] as const,
        );
        const deferred = yield* Deferred.make<unknown, CodexError.CodexAppServerError>();
        yield* Ref.update(pending, (current) =>
          new Map(current).set(String(requestId), { deferred, method }),
        );
        yield* offerOutgoing({
          id: requestId,
          method,
          ...(payload !== undefined ? { params: payload } : {}),
        }).pipe(Effect.tapError(() => removePending(String(requestId))));
        return yield* Deferred.await(deferred).pipe(
          Effect.onInterrupt(() => removePending(String(requestId))),
        );
      });

    const notify = (method: string, payload?: unknown) =>
      offerOutgoing({
        method,
        ...(payload !== undefined ? { params: payload } : {}),
      });

    return {
      incomingNotifications: Stream.fromQueue(incomingNotifications),
      incomingRequests: Stream.fromQueue(incomingRequests),
      request,
      notify,
      respond,
      respondError,
    } satisfies CodexAppServerPatchedProtocol;
  },
);
