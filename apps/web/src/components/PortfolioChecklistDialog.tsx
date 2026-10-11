import type { EnvironmentId, ThreadChecklistItem, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  CHECKLIST_STATUS_LABEL,
  CHECKLIST_STATUS_ORDER,
  ChecklistItemMenu,
  quoteChecklistItem,
} from "./chat/ThreadChecklistPanel";
import { revealInTimelineWhenLoaded } from "./chat/timelineReveal";
import { relativeLabel } from "./settings/ScheduledTasksSettings";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

export interface PortfolioThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly projectName: string | null;
  /** The thread's latest run, to tell a checklist that is behind. */
  readonly latestRunId: string | null;
  readonly working: boolean;
}

/** How many checklists one press of "write missing and outdated" may rewrite; each is a model call. */
const REFRESH_BATCH = 5;

/**
 * The checklists of all open threads in one place: what needs the user across
 * the whole portfolio, and on request what is open, parked or done. Reads the
 * stored checklists; a model is only called when the user asks for an update.
 */
export function PortfolioChecklistDialog({
  environmentId,
  threads,
  initialStatus,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<PortfolioThread>;
  /** The group shown first; "Needs you" when left out. */
  readonly initialStatus?: ThreadChecklistItem["status"] | undefined;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const input = useMemo(() => ({}), []);
  const query = useEnvironmentQuery(serverEnvironment.threadChecklists({ environmentId, input }));
  const refresh = useAtomCommand(serverEnvironment.refreshThreadChecklist, "update checklist");
  const [status, setStatus] = useState<ThreadChecklistItem["status"]>(initialStatus ?? "attention");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const checklistByThread = useMemo(
    () => new Map((query.data?.checklists ?? []).map((entry) => [entry.threadId as string, entry])),
    [query.data],
  );
  const mine = threads.filter((thread) => thread.environmentId === environmentId);
  const rows = mine.map((thread) => {
    const checklist = checklistByThread.get(thread.id) ?? null;
    return {
      thread,
      checklist,
      behind:
        thread.latestRunId !== null &&
        (checklist === null || checklist.basedOnRunId !== thread.latestRunId),
    };
  });
  const counts = Object.fromEntries(
    CHECKLIST_STATUS_ORDER.map((entry) => [
      entry,
      rows.reduce(
        (total, row) =>
          total + (row.checklist?.items.filter((item) => item.status === entry).length ?? 0),
        0,
      ),
    ]),
  ) as Record<ThreadChecklistItem["status"], number>;
  const shown = rows
    .map((row) => ({
      ...row,
      items: row.checklist?.items.filter((item) => item.status === status) ?? [],
    }))
    .filter((row) => row.items.length > 0);
  const toUpdate = rows.filter((row) => row.behind && !row.thread.working);

  const updateBatch = async () => {
    const batch = toUpdate.slice(0, REFRESH_BATCH);
    setProgress({ done: 0, total: batch.length });
    try {
      for (const [index, row] of batch.entries()) {
        await refresh({ environmentId, input: { threadId: row.thread.id } });
        setProgress({ done: index + 1, total: batch.length });
      }
    } finally {
      setProgress(null);
      query.refresh();
    }
  };
  const openThread = (thread: PortfolioThread) => {
    onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: thread.id },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>All open threads</DialogTitle>
          <DialogDescription>
            What the checklists of your open threads say, together.{" "}
            {rows.filter((row) => row.checklist !== null).length} of {rows.length} threads have a
            checklist{toUpdate.length > 0 ? `, ${toUpdate.length} are missing or behind` : ""}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
            <ToggleGroup
              value={[status]}
              onValueChange={(next) => {
                const picked = next[0] as ThreadChecklistItem["status"] | undefined;
                if (picked) setStatus(picked);
              }}
            >
              {CHECKLIST_STATUS_ORDER.map((entry) => (
                <Toggle key={entry} value={entry}>
                  {CHECKLIST_STATUS_LABEL[entry]} · {counts[entry]}
                </Toggle>
              ))}
            </ToggleGroup>
            <Button
              size="xs"
              variant="outline"
              disabled={progress !== null || toUpdate.length === 0}
              onClick={() => void updateBatch()}
            >
              {progress !== null
                ? `Reading ${progress.done + 1} of ${progress.total}…`
                : toUpdate.length === 0
                  ? "All checklists are current"
                  : `Write ${Math.min(REFRESH_BATCH, toUpdate.length)} missing or outdated`}
            </Button>
          </div>
          {query.data === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading…
            </p>
          ) : shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {counts[status] === 0 && rows.every((row) => row.checklist === null)
                ? "No thread has a checklist yet. Write them with the button above, or open a thread."
                : `Nothing under "${CHECKLIST_STATUS_LABEL[status]}".`}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {shown.map((row) => (
                <li
                  key={row.thread.id}
                  className="rounded-md border border-border p-3"
                  data-testid="portfolio-checklist-thread"
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => openThread(row.thread)}
                      className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                    >
                      {row.thread.projectName
                        ? `${row.thread.projectName} · ${row.thread.title}`
                        : row.thread.title}
                    </button>
                    <span className="shrink-0 text-2xs text-muted-foreground">
                      {row.checklist ? relativeLabel(row.checklist.generatedAt) : ""}
                      {row.behind ? " · behind" : ""}
                    </span>
                  </div>
                  <ul className="mt-2 flex flex-col gap-1 text-xs">
                    {row.items.map((item) => (
                      <li key={item.text}>
                        <ChecklistItemMenu
                          item={item}
                          showLabel="Open the thread at this point"
                          onShow={() => {
                            openThread(row.thread);
                            if (item.messageId !== undefined) {
                              revealInTimelineWhenLoaded(item.messageId);
                            }
                          }}
                          takeUpLabel="Take up in that thread's composer"
                          onTakeUp={() => {
                            quoteChecklistItem(
                              scopeThreadRef(row.thread.environmentId, row.thread.id),
                              item,
                            );
                            openThread(row.thread);
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
