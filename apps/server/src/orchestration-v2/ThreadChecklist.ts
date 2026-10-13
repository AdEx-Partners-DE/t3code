/**
 * Keeps a checklist per thread: what is done, what is open, what is parked,
 * and what waits on the user, written by a model from the thread's history.
 *
 * Long threads bury things, above all when automations add a turn every few
 * minutes. The checklist is the short view that stays readable. It is derived
 * and can be thrown away: each one is a file in the state directory, rewritten
 * on refresh.
 *
 * @module ThreadChecklist
 */
import { ThreadChecklist as ThreadChecklistSchema, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { isOpenThread } from "./OpenThreadModelOverride.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { recordDecision } from "../decisionLog.ts";
import {
  buildChecklistTranscriptWithSources,
  checklistIsCurrent,
  latestFinishedRunId,
  messagesOfFinishedTurns,
  turnsFinishedSince,
} from "./threadChecklistTranscript.ts";

const CHECKLIST_DIRECTORY = "thread-checklists";
/** Fits the context of every model offered for text generation, with room for the reply. */
const TRANSCRIPT_BUDGET = 90_000;

type Checklist = typeof ThreadChecklistSchema.Type;
const decodeChecklist = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadChecklistSchema));
const encodeChecklist = Schema.encodeSync(Schema.fromJsonString(ThreadChecklistSchema));

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const directory = path.join(config.stateDir, CHECKLIST_DIRECTORY);
  // Two at a time: a refresh is a model call, and a client may ask for several threads at once.
  const lock = yield* Semaphore.make(2);

  // One rewrite per thread at a time, so a second request waits for the
  // first one's result instead of making the same model call beside it.
  const threadLocks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (threadId: ThreadId) => {
    const known = threadLocks.get(threadId);
    if (known !== undefined) return known;
    const created = Semaphore.makeUnsafe(1);
    threadLocks.set(threadId, created);
    return created;
  };

  // Thread ids hold characters a file name cannot; the id's own uuids keep names apart.
  const fileOf = (threadId: ThreadId) =>
    path.join(directory, `${threadId.replace(/[^A-Za-z0-9_-]/g, "_").slice(-150)}.json`);

  const read = (threadId: ThreadId): Effect.Effect<Checklist | null> =>
    fileSystem.readFileString(fileOf(threadId)).pipe(
      Effect.map((contents) => {
        const decoded = decodeChecklist(contents);
        return decoded._tag === "Some" ? decoded.value : null;
      }),
      Effect.orElseSucceed(() => null),
    );

  /** Turns finished since the checklist was written; all of them when there is none. */
  const turnsBehind = Effect.fn("ThreadChecklist.turnsBehind")(function* (
    threadId: ThreadId,
    checklist: Checklist | null,
  ) {
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
    return turnsFinishedSince(runs, checklist?.basedOnRunId ?? null);
  });

  const refresh = Effect.fn("ThreadChecklist.refresh")(function* (
    threadId: ThreadId,
    trigger: "auto" | "manual" | "batch" = "manual",
  ) {
    const startedAt = yield* DateTime.now;
    const modelSelection = (yield* settings.getSettings).textGenerationModelSelection;
    const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
    // Threads that run on a timer are rarely idle, so the checklist is also
    // written while a turn runs: from the turns that have ended.
    const basedOnRunId = latestFinishedRunId(records.runs);
    const previous = yield* read(threadId);
    // Two clients with the same thread open both ask for the automatic
    // rewrite. The second finds the first one's result and takes it.
    if (trigger === "auto" && previous !== null && checklistIsCurrent(previous, basedOnRunId)) {
      return previous;
    }
    const { transcript, messageIdOfEntry } = buildChecklistTranscriptWithSources(
      messagesOfFinishedTurns(records.messages, records.runs),
      TRANSCRIPT_BUDGET,
    );
    const generated =
      transcript === ""
        ? { items: [] }
        : yield* textGeneration.generateThreadChecklist!({
            // A neutral directory: the checklist is written from the transcript
            // alone, not from a project's instructions.
            cwd: config.stateDir,
            transcript,
            previous: previous?.items.map((item) => ({ text: item.text, status: item.status })),
            modelSelection,
          });
    const checklist: Checklist = {
      threadId,
      generatedAt: DateTime.formatIso(yield* DateTime.now),
      basedOnRunId,
      items: generated.items.map((item) => {
        const messageId = item.entry === undefined ? undefined : messageIdOfEntry.get(item.entry);
        return {
          text: item.text,
          status: item.status,
          ...(item.note === undefined ? {} : { note: item.note }),
          ...(messageId === undefined ? {} : { messageId }),
        };
      }),
    };
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    const encoded = encodeChecklist(checklist);
    yield* fileSystem.writeFileString(fileOf(threadId), encoded);
    // What each rewrite cost and what it produced, so the model for this job
    // can be judged from numbers later. Characters stand in for tokens: the
    // text generation layer does not report usage.
    const count = (status: string) =>
      checklist.items.filter((item) => item.status === status).length;
    yield* recordDecision({
      kind: "checklist-generated",
      threadId,
      outcome: transcript === "" ? "empty-thread" : "written",
      facts: {
        trigger,
        instanceId: modelSelection.instanceId,
        model: modelSelection.model,
        promptChars: transcript.length,
        replyChars: encoded.length,
        durationMs: DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(startedAt),
        messages: records.messages.length,
        items: checklist.items.length,
        attention: count("attention"),
        open: count("open"),
        backlog: count("backlog"),
        done: count("done"),
        itemsWithPlace: checklist.items.filter((item) => item.messageId !== undefined).length,
        hadPrevious: previous !== null,
      },
    });
    return checklist;
  });

  const listOpen = threads.getShellSnapshot().pipe(
    Effect.flatMap((shell) =>
      Effect.forEach(shell.threads.filter(isOpenThread), (thread) => read(thread.id), {
        concurrency: 8,
      }),
    ),
    Effect.map((checklists) => checklists.filter((checklist) => checklist !== null)),
  );

  return {
    /** The stored checklist, or null when none was written yet. */
    read,
    /** The stored checklists of all open threads; threads without one are left out. */
    listOpen,
    /** Writes the checklist anew from the thread as it stands and stores it. */
    refresh: (threadId: ThreadId, trigger?: "auto" | "manual" | "batch") =>
      lockOf(threadId).withPermits(1)(lock.withPermits(1)(refresh(threadId, trigger))),
    turnsBehind,
  };
});
