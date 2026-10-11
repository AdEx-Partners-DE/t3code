import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";

const NUDGE_TEXT_KEY = "t3code:nudge-idle-threads:text";
const DEFAULT_NUDGE_TEXT =
  "Continue with what is next on this work. If nothing is left to do, say so in one line and stop.";
const DEFAULT_LIMIT = "5";

/**
 * One message to every open thread that stands still, so the user does not
 * visit each to say "go on". The cap keeps one click from starting every
 * thread at once.
 */
export function NudgeIdleThreads() {
  const { connectedEnvironments } = useSettingsScope();
  const environment = connectedEnvironments[0] ?? null;
  const allowed = useAtomValue(
    serverEnvironment.nudgeIdleThreads.permissionAtom(environment?.environmentId ?? null),
  );
  const nudge = useAtomCommand(serverEnvironment.nudgeIdleThreads);
  const [text, setText] = useLocalStorage(NUDGE_TEXT_KEY, DEFAULT_NUDGE_TEXT, Schema.String);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [pending, setPending] = useState(false);
  if (environment === null) return null;
  const limitNumber = Number(limit);
  const valid =
    text.trim() !== "" && Number.isInteger(limitNumber) && limitNumber >= 1 && limitNumber <= 50;

  const send = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Send this message to up to ${limitNumber} open ${limitNumber === 1 ? "thread" : "threads"} on ${environment.label} that stand still? Each starts a turn now. Threads that work, wait on an answer, failed or are snoozed are left alone.`,
    );
    if (!confirmed) return;
    setPending(true);
    try {
      const result = await nudge({
        environmentId: environment.environmentId,
        input: { commandId: CommandId.make(randomUUID()), text: text.trim(), limit: limitNumber },
      });
      if (result._tag === "Success") {
        const { sent, still } = result.value;
        toastManager.add({
          type: "success",
          title:
            still === 0
              ? "No open thread stands still"
              : `Sent to ${sent} of ${still} ${still === 1 ? "thread" : "threads"} standing still`,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not send to the open threads",
          description: String(squashAtomCommandFailure(result)),
        });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex w-full max-w-xl flex-wrap items-center justify-end gap-2">
      <Input
        nativeInput
        aria-label="Message for all idle threads"
        className="min-w-64 flex-1"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Input
        type="number"
        nativeInput
        aria-label="At most this many threads"
        min={1}
        max={50}
        step={1}
        className="w-16"
        value={limit}
        onChange={(event) => setLimit(event.target.value)}
      />
      <Button size="xs" disabled={pending || !allowed || !valid} onClick={() => void send()}>
        Send to idle threads
      </Button>
    </div>
  );
}
