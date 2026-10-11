import { CommandId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";

const RESTORE_WINDOW_MINUTES = 24 * 60;

/** Empties every thread's queue on the selected environments, after asking, and puts cleared messages back. */
export function ClearAllQueuesButton() {
  const { connectedEnvironments } = useSettingsScope();
  const clear = useAtomCommand(serverEnvironment.clearAllQueues);
  const restore = useAtomCommand(serverEnvironment.clearAllQueues);
  const [pending, setPending] = useState(false);
  const allowed = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          connectedEnvironments.filter((environment) =>
            get(serverEnvironment.clearAllQueues.permissionAtom(environment.environmentId)),
          ),
        ),
      [connectedEnvironments],
    ),
  );
  const run = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      "Remove every queued message in every thread? Runs under way go on. You can restore them for 24 hours.",
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setPending(true);
    try {
      await Promise.all(
        allowed.map(async (environment) => {
          const result = await clear({
            environmentId: environment.environmentId,
            input: { commandId: CommandId.make(randomUUID()) },
          });
          if (result._tag === "Success") {
            const { threads } = result.value;
            toastManager.add({
              type: "success",
              title:
                threads === 0
                  ? `Nothing was queued on ${environment.label}`
                  : `Cleared the queue of ${threads} ${threads === 1 ? "thread" : "threads"} on ${environment.label}`,
            });
          } else if (!isAtomCommandInterrupted(result)) {
            toastManager.add({
              type: "error",
              title: `Could not clear the queues on ${environment.label}`,
              description: String(squashAtomCommandFailure(result)),
            });
          }
        }),
      );
    } finally {
      setPending(false);
    }
  };
  const restoreAll = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      "Put back every message that Clear queue removed in the last 24 hours? Each goes back into its thread's queue once.",
    );
    if (!confirmed) return;
    setPending(true);
    try {
      await Promise.all(
        allowed.map(async (environment) => {
          const result = await restore({
            environmentId: environment.environmentId,
            input: {
              commandId: CommandId.make(randomUUID()),
              restore: { maxAgeMinutes: RESTORE_WINDOW_MINUTES },
            },
          });
          if (result._tag === "Success") {
            const { threads } = result.value;
            const messages = result.value.messages ?? 0;
            const heldBack = result.value.heldBack ?? 0;
            toastManager.add({
              type: "success",
              title:
                messages === 0 && heldBack === 0
                  ? `Nothing to restore on ${environment.label}`
                  : `Put back ${messages} ${messages === 1 ? "message" : "messages"} in ${threads} ${threads === 1 ? "thread" : "threads"} on ${environment.label}`,
              ...(heldBack > 0
                ? {
                    description: `${heldBack} more ${heldBack === 1 ? "waits" : "wait"} in threads that stand still: they would start at once. Turn off "Pause all queues", then restore again.`,
                  }
                : {}),
            });
          } else if (!isAtomCommandInterrupted(result)) {
            toastManager.add({
              type: "error",
              title: `Could not restore the queues on ${environment.label}`,
              description: String(squashAtomCommandFailure(result)),
            });
          }
        }),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={pending || allowed.length === 0}
        onClick={() => void restoreAll()}
      >
        Restore cleared
      </Button>
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={pending || allowed.length === 0}
        onClick={() => void run()}
      >
        Clear all queues
      </Button>
    </div>
  );
}
