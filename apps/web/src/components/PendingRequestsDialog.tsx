import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { EnvironmentId, ProviderApprovalDecision, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { useThreadProjection } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export interface PendingRequestThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  /** Shown before the title so two threads of different projects can be told apart. */
  readonly projectName: string | null;
}

/**
 * Every request that waits on the user, across threads, answerable in place.
 * Approvals get Allow and Decline; a question needs its thread's form, so it
 * gets a way there instead.
 */
export function PendingRequestsDialog({
  threads,
  onClose,
}: {
  readonly threads: ReadonlyArray<PendingRequestThread>;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Waiting on you</DialogTitle>
          <DialogDescription>
            Answer the open requests of every thread here. A request disappears once its thread has
            your answer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {threads.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing waits on you.</p>
          ) : (
            <ul className="space-y-3">
              {threads.map((thread) => (
                <PendingRequestThreadRows
                  key={`${thread.environmentId}:${thread.id}`}
                  thread={thread}
                  onClose={onClose}
                />
              ))}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function PendingRequestThreadRows({
  thread,
  onClose,
}: {
  readonly thread: PendingRequestThread;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const projection = useThreadProjection(
    scopeThreadRef(thread.environmentId, thread.id),
  )?.projection;
  const requests = useMemo(
    () => (projection ? derivePendingThreadRequests(projection) : null),
    [projection],
  );
  const respond = useAtomCommand(threadEnvironment.respondToApproval, "answer request");
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const openThread = () => {
    onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: thread.id },
    });
  };
  const answer = async (
    requestId: (typeof approvals)[number]["requestId"],
    decision: ProviderApprovalDecision,
  ) => {
    setBusyRequestId(requestId);
    try {
      await respond({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, requestId, decision },
      });
    } finally {
      setBusyRequestId(null);
    }
  };
  const approvals = requests?.approvals ?? [];
  const questions = requests?.userInputs ?? [];
  const heading = thread.projectName ? `${thread.projectName} · ${thread.title}` : thread.title;
  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{heading}</span>
        <Button size="xs" variant="ghost" onClick={openThread}>
          Open thread
        </Button>
      </div>
      {requests === null ? (
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          Loading…
        </p>
      ) : approvals.length === 0 && questions.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Answered.</p>
      ) : null}
      {approvals.map((approval) => (
        <div key={approval.requestId} className="mt-2 flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-sm break-words whitespace-pre-wrap text-muted-foreground">
            {approval.appName ? `${approval.appName}: ` : ""}
            {approval.detail ?? `Approval needed (${approval.requestKind})`}
          </p>
          {approval.responseCapability === "live" ? (
            <div className="flex shrink-0 gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={busyRequestId !== null}
                onClick={() => void answer(approval.requestId, "decline")}
              >
                Decline
              </Button>
              <Button
                size="xs"
                disabled={busyRequestId !== null}
                onClick={() => void answer(approval.requestId, "accept")}
              >
                Allow
              </Button>
            </div>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">Open the thread</span>
          )}
        </div>
      ))}
      {questions.map((question) => (
        <div key={question.requestId} className="mt-2 flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-sm break-words text-muted-foreground">
            {question.questions[0]?.question ?? "The agent has a question."}
            {question.questions.length > 1 ? ` (+${question.questions.length - 1} more)` : null}
          </p>
          <Button size="xs" variant="outline" onClick={openThread}>
            Answer
          </Button>
        </div>
      ))}
    </li>
  );
}
