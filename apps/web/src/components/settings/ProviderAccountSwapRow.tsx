import { CommandId, type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

export interface ProviderAccountSwapTarget {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}

/**
 * Moves this account's threads to another account of the same provider, keeping model and
 * options. The other account's card offers the same move back.
 */
export function ProviderAccountSwapRow(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly targets: ReadonlyArray<ProviderAccountSwapTarget>;
  /** The text generation model runs on this account and the user may change settings. */
  readonly movesTextGeneration: boolean;
}) {
  const gt = useGT();
  const swap = useAtomCommand(serverEnvironment.swapProviderInstance);
  const allowed = useAtomValue(
    serverEnvironment.swapProviderInstance.permissionAtom(props.environmentId),
  );
  // A count, so the row re-renders only when the number changes.
  const threadCount = useAtomValue(
    environmentThreadShells.threadShellsAtom,
    (threads) =>
      threads.filter(
        (thread) =>
          thread.environmentId === props.environmentId &&
          thread.modelSelection.instanceId === props.instanceId,
      ).length,
  );
  const [pending, setPending] = useState(false);
  if (props.targets.length === 0) return null;

  const move = async (target: ProviderAccountSwapTarget) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      [
        gt(
          "Move {count, plural, one {# thread} other {# threads}} and their scheduled tasks from {from} to {to}? Model and options stay; each thread's next turn starts on {to} with its context handed over.",
          { count: threadCount, from: props.label, to: target.label },
        ),
        props.movesTextGeneration ? gt("The text generation model moves too.") : null,
        gt(
          "Threads with a run under way stay on {from}. Archived threads stay. You can move them back the same way.",
          { from: props.label },
        ),
      ]
        .filter((line) => line !== null)
        .join("\n\n"),
    );
    if (!confirmed) return;
    setPending(true);
    // The command settles into a result instead of throwing, so no `try` is needed.
    const result = await swap({
      environmentId: props.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        fromInstanceId: props.instanceId,
        toInstanceId: target.instanceId,
        includeTextGeneration: props.movesTextGeneration,
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      const { moved, busy, failed, scheduledTasksMoved, textGenerationMoved } = result.value;
      const details = [
        busy.length > 0
          ? gt(
              "{count, plural, one {# thread with a run under way stayed} other {# threads with a run under way stayed}}; move again after it ends.",
              { count: busy.length },
            )
          : null,
        failed.length > 0
          ? gt(
              "{count, plural, one {# thread could not move} other {# threads could not move}}: {reason}",
              {
                count: failed.length,
                reason: failed[0]!.reason,
              },
            )
          : null,
        scheduledTasksMoved > 0
          ? gt("{count, plural, one {# scheduled task moved} other {# scheduled tasks moved}}.", {
              count: scheduledTasksMoved,
            })
          : null,
        textGenerationMoved ? gt("The text generation model moved.") : null,
      ].filter((line) => line !== null);
      toastManager.add({
        type: busy.length > 0 || failed.length > 0 ? "warning" : "success",
        title: gt("Moved {count, plural, one {# thread} other {# threads}} to {to}", {
          count: moved,
          to: target.label,
        }),
        ...(details.length > 0 ? { description: details.join(" ") } : {}),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not move the threads to {to}", { to: target.label }),
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <SettingsRow
      title={gt("Threads")}
      description={gt(
        "{count, plural, =0 {No open thread uses this account.} one {# open thread uses this account.} other {# open threads use this account.}} Move them to another account of the same provider; model and options stay.",
        { count: threadCount },
      )}
      control={
        <Menu>
          <MenuTrigger
            render={<Button size="sm" variant="outline" disabled={pending || !allowed} />}
          >
            {gt("Move threads to…")}
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            {props.targets.map((target) => (
              <MenuItem key={target.instanceId} onClick={() => void move(target)}>
                {target.label}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      }
    />
  );
}
