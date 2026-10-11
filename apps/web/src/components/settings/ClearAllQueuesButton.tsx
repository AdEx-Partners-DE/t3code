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

/** Empties every thread's queue on the selected environments, after asking. */
export function ClearAllQueuesButton() {
  const { connectedEnvironments } = useSettingsScope();
  const clear = useAtomCommand(serverEnvironment.clearAllQueues);
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
      "Remove every queued message in every thread? Runs under way go on. This cannot be undone.",
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
  return (
    <Button
      size="xs"
      variant="destructive-outline"
      disabled={pending || allowed.length === 0}
      onClick={() => void run()}
    >
      Clear all queues
    </Button>
  );
}
