/**
 * Sets one model, one thinking level, or both on every open thread at once,
 * and puts the previous selections back on request.
 *
 * A thread's selection is what its next turn runs on, so the change takes
 * effect with the next message in each thread; a run under way is not touched.
 * The selections that were replaced are kept in a file in the state directory,
 * so the way back survives a restart.
 *
 * @module OpenThreadModelOverride
 */
import {
  CommandId,
  ModelSelection,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { overriddenModelSelection, type ModelOverride } from "@t3tools/shared/modelOverride";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const MODEL_OVERRIDE_FILE_NAME = "open-thread-model-override.json";

/** Per thread: what it had before the first override, and what the override set. */
const SavedSelections = Schema.Record(
  ThreadId,
  Schema.Struct({ previous: ModelSelection, applied: ModelSelection }),
);
type SavedSelections = typeof SavedSelections.Type;
const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(SavedSelections));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(SavedSelections));

/**
 * Open means the user still has it on the list: not archived, deleted or
 * settled. A subagent's thread is not on the list; it belongs to the run that
 * started it and is left alone.
 */
export function isOpenThread(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "settledAt" | "settledOverride" | "lineage"
  >,
): boolean {
  return (
    thread.lineage.relationshipToParent !== "subagent" &&
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    (thread.settledAt === null || thread.settledOverride === "active")
  );
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, MODEL_OVERRIDE_FILE_NAME);
  const lock = yield* Semaphore.make(1);

  const readSaved = fileSystem.readFileString(filePath).pipe(
    Effect.map((contents) => {
      const decoded = decodeSaved(contents);
      return decoded._tag === "Some" ? decoded.value : ({} as SavedSelections);
    }),
    Effect.orElseSucceed(() => ({}) as SavedSelections),
  );

  const apply = Effect.fn("OpenThreadModelOverride.apply")(function* (input: {
    readonly commandId: CommandId;
    readonly override: ModelOverride;
  }) {
    const providers = yield* registry.getProviders;
    const shell = yield* threads.getShellSnapshot();
    const saved: Record<string, SavedSelections[ThreadId]> = { ...(yield* readSaved) };
    let changed = 0;
    for (const thread of shell.threads) {
      if (!isOpenThread(thread)) continue;
      const next = overriddenModelSelection({
        current: thread.modelSelection,
        override: input.override,
        providers,
      });
      if (next === null) continue;
      const set = yield* threads
        .dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${input.commandId}:model:${thread.id}`),
          threadId: thread.id,
          modelSelection: next,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("Could not set the model of a thread", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      if (!set) continue;
      changed += 1;
      // A second override on top of the first still restores to the original.
      saved[thread.id] = {
        previous: saved[thread.id]?.previous ?? thread.modelSelection,
        applied: next,
      };
    }
    if (changed > 0) {
      yield* fileSystem.writeFileString(filePath, encodeSaved(saved as SavedSelections));
    }
    yield* Effect.logInfo("Model set on open threads", { threads: changed });
    return { threads: changed };
  });

  const restore = Effect.fn("OpenThreadModelOverride.restore")(function* (input: {
    readonly commandId: CommandId;
  }) {
    const saved = yield* readSaved;
    const shell = yield* threads.getShellSnapshot();
    const byId = new Map(shell.threads.map((thread) => [thread.id as string, thread]));
    let restored = 0;
    for (const [threadId, entry] of Object.entries(saved)) {
      const thread = byId.get(threadId);
      // A thread the user has moved to another model since then keeps that choice.
      if (
        thread === undefined ||
        thread.archivedAt !== null ||
        !modelSelectionsEqual(thread.modelSelection, entry.applied)
      )
        continue;
      const set = yield* threads
        .dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${input.commandId}:model:${threadId}`),
          threadId: thread.id,
          modelSelection: entry.previous,
        })
        .pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      if (set) restored += 1;
    }
    yield* fileSystem.remove(filePath).pipe(Effect.ignore);
    yield* Effect.logInfo("Previous models restored on open threads", { threads: restored });
    return { threads: restored };
  });

  return {
    /** Sets the override on every open thread and reports how many changed. */
    apply: (input: Parameters<typeof apply>[0]) => lock.withPermits(1)(apply(input)),
    /** Puts back what `apply` replaced, where the thread still has what it set. */
    restore: (input: Parameters<typeof restore>[0]) => lock.withPermits(1)(restore(input)),
  };
});
