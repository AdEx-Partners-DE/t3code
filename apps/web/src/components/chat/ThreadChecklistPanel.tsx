import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ThreadChecklist,
  ThreadChecklistItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { relativeLabel } from "../settings/ScheduledTasksSettings";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const AUTO_REFRESH_KEY = "t3code:thread-checklist:auto";
/** A stale checklist is rewritten on its own at most this often; each rewrite is a model call. */
const AUTO_REFRESH_MIN_AGE_MS = 15 * 60_000;
const DONE_SHOWN = 5;

const STATUS_ORDER = ["attention", "open", "backlog", "done"] as const;
const STATUS_LABEL: Record<ThreadChecklistItem["status"], string> = {
  attention: "Needs you",
  open: "Open",
  backlog: "Backlog",
  done: "Done",
};

function StatusIcon({ status }: { readonly status: ThreadChecklistItem["status"] }) {
  const className = "mt-0.5 size-3.5 shrink-0";
  switch (status) {
    case "attention":
      return <CircleAlertIcon className={cn(className, "text-destructive")} aria-hidden />;
    case "open":
      return <CircleIcon className={cn(className, "text-warning")} aria-hidden />;
    case "backlog":
      return <CircleDashedIcon className={cn(className, "text-muted-foreground/70")} aria-hidden />;
    case "done":
      return <CheckIcon className={cn(className, "text-success")} aria-hidden />;
  }
}

/**
 * The thread as a checklist: what needs the user, what is open, what is
 * parked and what is done, written by a model from the whole history so that
 * points buried many turns back stay in view.
 */
export function ThreadChecklistPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const input = useMemo(() => ({ threadId }), [threadId]);
  const stored = useEnvironmentQuery(serverEnvironment.threadChecklist({ environmentId, input }));
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const allowed = useAtomValue(
    serverEnvironment.refreshThreadChecklist.permissionAtom(environmentId),
  );
  const refresh = useAtomCommand(serverEnvironment.refreshThreadChecklist);
  // What the last refresh returned, until the query catches up.
  const [fresh, setFresh] = useState<ThreadChecklist | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);
  const [auto, setAuto] = useLocalStorage(AUTO_REFRESH_KEY, true, Schema.Boolean);
  const checklist = fresh ?? stored.data?.checklist ?? null;
  const loaded = stored.data !== undefined && stored.data !== null;
  const latestRunId = shell?.latestRun?.runId ?? null;
  const hasRun = latestRunId !== null;
  const working = threadRuntimeIsActive(shell?.runtime);
  const stale = checklist !== null && hasRun && checklist.basedOnRunId !== latestRunId;

  const run = async (quiet: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await refresh({ environmentId, input: { threadId } });
      if (result._tag === "Success") {
        setFresh(result.value.checklist);
      } else if (!quiet && !isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update the checklist",
            description: String(squashAtomCommandFailure(result)),
          }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  // Rewrite on its own once the thread has moved on and stands still. One
  // attempt per run, so a failing model is not asked again and again.
  const attemptedForRun = useRef<string | null>(null);
  useEffect(() => {
    if (!auto || !allowed || !loaded || !hasRun || working || busy) return;
    if (latestRunId === null || attemptedForRun.current === latestRunId) return;
    const needed =
      checklist === null ||
      (stale && Date.now() - Date.parse(checklist.generatedAt) >= AUTO_REFRESH_MIN_AGE_MS);
    if (!needed) return;
    attemptedForRun.current = latestRunId;
    void run(true);
    // `run` closes over the same values this effect lists.
  }, [allowed, auto, busy, checklist, hasRun, loaded, latestRunId, stale, working]);

  const groups = STATUS_ORDER.map((status) => ({
    status,
    items: (checklist?.items ?? []).filter((item) => item.status === status),
  })).filter((group) => group.items.length > 0);

  return (
    <ThreadDetailsSection
      headingId="thread-details-checklist-heading"
      title="Checklist"
      data-thread-checklist-panel
      actions={
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  aria-pressed={auto}
                  aria-label="Update the checklist automatically"
                  onClick={() => setAuto((value) => !value)}
                >
                  {auto ? "Auto" : "Manual"}
                </ThreadDetailsControl>
              }
            />
            <TooltipPopup>
              {auto
                ? "Rewritten by a model when the thread has moved on, at most every 15 minutes."
                : "Rewritten only when you press update."}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label="Update the checklist now"
                  disabled={busy || !allowed || !hasRun}
                  onClick={() => void run(false)}
                >
                  <RefreshCwIcon className="size-3.5" />
                </ThreadDetailsControl>
              }
            />
            <TooltipPopup>Have a model read the thread and rewrite the checklist</TooltipPopup>
          </Tooltip>
        </>
      }
    >
      <div className="flex flex-col gap-2 px-1.5 text-xs">
        {busy ? (
          <p className="text-muted-foreground" role="status">
            Reading the thread…
          </p>
        ) : null}
        {checklist === null && !busy ? (
          <p className="text-muted-foreground">
            {hasRun
              ? "No checklist yet. Press update to have a model write one from this thread."
              : "The checklist appears once the thread has done a turn."}
          </p>
        ) : null}
        {checklist !== null && checklist.items.length === 0 && !busy ? (
          <p className="text-muted-foreground">Nothing to list for this thread.</p>
        ) : null}
        {groups.map((group) => {
          const shown =
            group.status === "done" && !showAllDone
              ? group.items.slice(0, DONE_SHOWN)
              : group.items;
          return (
            <div key={group.status} className="flex flex-col gap-1">
              <div className="text-2xs font-medium text-muted-foreground select-none">
                {STATUS_LABEL[group.status]} · {group.items.length}
              </div>
              <ul className="flex flex-col gap-1">
                {shown.map((item) => (
                  <li key={`${item.status}:${item.text}`} className="flex gap-1.5">
                    <StatusIcon status={item.status} />
                    <div className="min-w-0">
                      <div
                        className={cn(
                          "break-words",
                          item.status === "done" && "text-muted-foreground",
                          item.status === "attention" && "font-medium",
                        )}
                      >
                        {item.text}
                      </div>
                      {item.note ? (
                        <div className="break-words text-2xs text-muted-foreground">
                          {item.note}
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
              {group.status === "done" && group.items.length > DONE_SHOWN ? (
                <button
                  type="button"
                  onClick={() => setShowAllDone((value) => !value)}
                  className="cursor-pointer self-start rounded-sm text-2xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                >
                  {showAllDone ? "Show fewer" : `Show ${group.items.length - DONE_SHOWN} more done`}
                </button>
              ) : null}
            </div>
          );
        })}
        {checklist !== null ? (
          <p className="text-2xs text-muted-foreground">
            Updated {relativeLabel(checklist.generatedAt)}
            {stale ? " · the thread has moved on since" : ""}
          </p>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
