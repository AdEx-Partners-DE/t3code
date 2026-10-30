import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
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
  CopyIcon,
  CornerDownLeftIcon,
  LocateFixedIcon,
  MessageSquarePlusIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { resolveComposerDraftKey, useComposerDraftStore } from "../../composerDraftStore";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { relativeLabel } from "../settings/ScheduledTasksSettings";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { checklistAutoRefreshNeeded } from "./ThreadChecklistPanel.logic";
import { revealInTimeline, revealInTimelineWhenLoaded } from "./timelineReveal";

const AUTO_REFRESH_KEY = "t3code:thread-checklist:auto";
const DONE_SHOWN = 5;

export const CHECKLIST_STATUS_ORDER = ["attention", "open", "backlog", "done"] as const;
export const CHECKLIST_STATUS_LABEL: Record<ThreadChecklistItem["status"], string> = {
  attention: "Needs you",
  open: "Open",
  backlog: "Backlog",
  done: "Done",
};

/** An item as plain text: its line and, if it has one, the note below. */
function checklistItemText(item: ThreadChecklistItem): string {
  return item.note ? `${item.text}\n${item.note}` : item.text;
}

/** Quotes the item into the message being written in that thread, so the user only adds what to do with it. */
export function quoteChecklistItem(
  threadRef: ScopedThreadRef,
  item: ThreadChecklistItem,
  /** A line above the quote saying where it is from, for a message read without the thread. */
  lead?: string,
): void {
  const store = useComposerDraftStore.getState();
  const key = resolveComposerDraftKey(store, threadRef);
  const existing = (key ? store.draftsByThreadKey[key]?.prompt : undefined) ?? "";
  const quote = checklistItemText(item)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const before = existing.trim() === "" ? "" : `${existing.trimEnd()}\n\n`;
  store.setPrompt(threadRef, `${before}${lead === undefined ? "" : `${lead}\n`}${quote}\n\n`);
}

/**
 * Opens a new thread in the item's project with the item quoted in its
 * composer. Nothing is sent: the user says what the new thread should do.
 */
export function useChecklistFollowUp() {
  const handleNewThread = useNewThreadHandler();
  return async (input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly threadTitle: string;
    readonly item: ThreadChecklistItem;
  }) => {
    const opened = await handleNewThread(scopeProjectRef(input.environmentId, input.projectId));
    if (opened === null || opened === undefined) return;
    quoteChecklistItem(
      scopeThreadRef(input.environmentId, opened.threadId),
      input.item,
      `From the thread "${input.threadTitle}":`,
    );
  };
}

/** Statuses the user can set by hand; the model keeps them when it rewrites the list. */
const SET_STATUS_ACTIONS: ReadonlyArray<{
  readonly status: ThreadChecklistItem["status"];
  readonly label: string;
}> = [
  { status: "done", label: "Mark done" },
  { status: "backlog", label: "Move to backlog" },
  { status: "open", label: "Mark open" },
  { status: "attention", label: "Needs me" },
];

/** A checklist item as a row that opens what can be done with it. */
export function ChecklistItemMenu(props: {
  readonly item: ThreadChecklistItem;
  readonly showLabel: string;
  readonly onShow: () => void;
  readonly takeUpLabel: string;
  readonly onTakeUp: () => void;
  /** Starts a new thread about the item; left out where the project is not known. */
  readonly onFollowUp?: (() => void) | undefined;
  /** Sets the item's status by hand; a rewrite keeps it. Left out without permission. */
  readonly onSetStatus?: ((status: ThreadChecklistItem["status"]) => void) | undefined;
  /** Gives a hand-set item back to the model, which rewrites the list. Left out without permission. */
  readonly onRelease?: (() => void) | undefined;
}) {
  const { item } = props;
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className="-mx-1 flex w-[calc(100%+0.5rem)] cursor-pointer gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset data-popup-open:bg-accent"
          />
        }
      >
        <ChecklistStatusIcon status={item.status} />
        <span className="min-w-0">
          <span
            className={cn(
              "block break-words",
              item.status === "done" && "text-muted-foreground",
              item.status === "attention" && "font-medium",
            )}
          >
            {item.text}
          </span>
          {item.note ? (
            <span className="block break-words text-2xs text-muted-foreground">{item.note}</span>
          ) : null}
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuItem onClick={props.onShow}>
          <LocateFixedIcon />
          {props.showLabel}
        </MenuItem>
        <MenuItem onClick={props.onTakeUp}>
          <CornerDownLeftIcon />
          {props.takeUpLabel}
        </MenuItem>
        {props.onFollowUp === undefined ? null : (
          <MenuItem onClick={props.onFollowUp}>
            <MessageSquarePlusIcon />
            Start a new thread with this
          </MenuItem>
        )}
        <MenuItem
          onClick={() => void writeTextToClipboard(checklistItemText(item), "checklist item")}
        >
          <CopyIcon />
          Copy
        </MenuItem>
        {props.onSetStatus === undefined
          ? null
          : SET_STATUS_ACTIONS.filter((action) => action.status !== item.status).map((action) => (
              <MenuItem key={action.status} onClick={() => props.onSetStatus?.(action.status)}>
                <ChecklistStatusIcon status={action.status} />
                {action.label}
              </MenuItem>
            ))}
        {props.onRelease === undefined || item.setByUser !== true ? null : (
          <MenuItem onClick={props.onRelease}>
            <SparklesIcon />
            Let the checklist decide
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}

function ChecklistStatusIcon({ status }: { readonly status: ThreadChecklistItem["status"] }) {
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
  const input = { threadId };
  const stored = useEnvironmentQuery(serverEnvironment.threadChecklist({ environmentId, input }));
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const allowed = useAtomValue(
    serverEnvironment.refreshThreadChecklist.permissionAtom(environmentId),
  );
  const refresh = useAtomCommand(serverEnvironment.refreshThreadChecklist);
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const followUp = useChecklistFollowUp();
  // What the last refresh returned, until the query catches up.
  const [fresh, setFresh] = useState<ThreadChecklist | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);
  const [auto, setAuto] = useLocalStorage(AUTO_REFRESH_KEY, true, Schema.Boolean);
  const checklist = fresh ?? stored.data?.checklist ?? null;
  const loaded = stored.data !== undefined && stored.data !== null;
  const latestRunId = shell?.latestRun?.runId ?? null;
  const hasRun = latestRunId !== null;
  const stale = checklist !== null && hasRun && checklist.basedOnRunId !== latestRunId;

  const run = async (quiet: boolean) => {
    if (busy) return;
    setBusy(true);
    // The command settles into a result instead of throwing, so no `try` is needed.
    const result = await refresh({
      environmentId,
      input: { threadId, trigger: quiet ? "auto" : "manual" },
    });
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
    setBusy(false);
  };

  const setStatus = async (item: ThreadChecklistItem, status: ThreadChecklistItem["status"]) => {
    const result = await refresh({
      environmentId,
      input: { threadId, setItem: { text: item.text, status } },
    });
    if (result._tag === "Success") {
      setFresh(result.value.checklist);
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change the checklist item",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  // Giving an item back rewrites the list, so it reads as busy like a refresh.
  const release = async (item: ThreadChecklistItem) => {
    if (busy) return;
    setBusy(true);
    // The command settles into a result instead of throwing, so no `try` is needed.
    const result = await refresh({
      environmentId,
      input: { threadId, trigger: "manual", releaseItem: { text: item.text } },
    });
    if (result._tag === "Success") {
      setFresh(result.value.checklist);
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not give the item back to the checklist",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
    setBusy(false);
  };

  // How far the checklist is behind is the server's count; ask again when a
  // turn has ended, or the number read on opening the thread would stand.
  const turnsBehind = stored.data?.turnsBehind ?? 0;
  const refreshStored = stored.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the server's turns-behind count when a turn ends
  useEffect(() => {
    if (auto && latestRunId !== null) refreshStored();
  }, [auto, latestRunId, refreshStored]);

  // Rewrite on its own once the thread has moved on. Threads on a timer are
  // rarely idle, so this does not wait for the running turn: the server writes
  // from the turns that have ended. One attempt per run, so a failing model is
  // not asked again and again.
  const attemptedForRun = useRef<string | null>(null);
  const [openedAt] = useState(() => Date.now());
  const fetchedAt = stored.dataUpdatedAt;
  const startAutoRefresh = useEffectEvent(() => {
    void run(true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for a model rewrite once per run after the thread moved on
  useEffect(() => {
    if (!auto || !allowed || !loaded || !hasRun || busy) return;
    if (latestRunId === null || attemptedForRun.current === latestRunId) return;
    // Not after every turn: a rewrite is a model call. A thread gets its
    // first checklist once it has a few turns, and a new one after a few more.
    const needed = checklistAutoRefreshNeeded({
      turnsBehind,
      checklistGeneratedAt: checklist?.generatedAt ?? null,
      stale,
      fetchedAt,
      openedAt,
      now: Date.now(),
    });
    if (!needed) return;
    attemptedForRun.current = latestRunId;
    // oxlint-disable-next-line react/set-state-in-effect -- The rewrite marks itself busy so a second trigger waits for it.
    startAutoRefresh();
  }, [
    allowed,
    auto,
    busy,
    checklist,
    fetchedAt,
    hasRun,
    loaded,
    latestRunId,
    openedAt,
    stale,
    turnsBehind,
  ]);

  const showInThread = async (item: ThreadChecklistItem) => {
    if (item.messageId !== undefined && revealInTimeline(item.messageId)) return;
    if (item.messageId !== undefined) {
      // Earlier turns load through the item's message; the timeline scrolls
      // there once it has the rows.
      revealInTimelineWhenLoaded(item.messageId);
      const loaded = await loadEarlierHistory({
        environmentId,
        input: { threadId, throughEntryId: item.messageId },
      });
      if (loaded._tag === "Success" && loaded.value._tag === "loaded") return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title:
          item.messageId === undefined
            ? "No place in the thread recorded for this item"
            : "That part of the thread is not loaded",
        description:
          item.messageId === undefined
            ? "Update the checklist once; items written from now on know their place."
            : "Scroll up to load earlier turns, then try again.",
      }),
    );
  };
  const groups = CHECKLIST_STATUS_ORDER.map((status) => ({
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
                ? "While this thread is open: rewritten by a model once it has finished 3 more turns and stands still, at most every 15 minutes. Threads you are not looking at are never rewritten on their own."
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
                {CHECKLIST_STATUS_LABEL[group.status]} · {group.items.length}
              </div>
              <ul className="flex flex-col gap-1">
                {shown.map((item) => (
                  <li key={`${item.status}:${item.text}`}>
                    <ChecklistItemMenu
                      item={item}
                      showLabel="Show in thread"
                      onShow={() => void showInThread(item)}
                      takeUpLabel="Take up in the composer"
                      onTakeUp={() =>
                        quoteChecklistItem(scopeThreadRef(environmentId, threadId), item)
                      }
                      onFollowUp={
                        shell === null || shell === undefined
                          ? undefined
                          : () =>
                              void followUp({
                                environmentId,
                                projectId: shell.projectId,
                                threadTitle: shell.title,
                                item,
                              })
                      }
                      onSetStatus={allowed ? (status) => void setStatus(item, status) : undefined}
                      onRelease={allowed ? () => void release(item) : undefined}
                    />
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
