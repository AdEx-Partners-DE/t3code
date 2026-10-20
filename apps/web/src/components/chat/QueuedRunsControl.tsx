import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  CommandId,
  type ChatAttachment as ContractChatAttachment,
  type EnvironmentId,
  type MessageId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  Clock3Icon,
  CornerUpRightIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PencilIcon,
} from "lucide-react";
import { useId, useImperativeHandle, useRef, useState, type Ref } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatMessage } from "../../types";
import { cn, randomUUID } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import {
  canMergeQueuedMessages,
  mergeQueuedMessageTexts,
  removeMergedQueuedRuns,
} from "./queuedMessageMerge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
}

interface QueuedRowThumbnail {
  readonly key: string;
  readonly name: string;
  readonly url: string | null;
}

const QUEUED_RUN_DRAG_TYPE = "application/x-t3code-queued-run";

export interface QueuedRunsControlHandle {
  steerNext: (repeat: boolean) => boolean;
  editLatest: (repeat: boolean) => boolean;
}

type ThreadQueueProjection = Parameters<typeof deriveThreadQueueWorkflowState>[0];

function queuedImageResources(projection: ThreadQueueProjection | undefined) {
  if (!projection) return [];
  return deriveThreadQueueWorkflowState(projection).queuedRuns.flatMap(({ attachments }) =>
    attachments.flatMap((attachment) =>
      attachment.type === "image"
        ? [{ _tag: "attachment" as const, attachmentId: attachment.id }]
        : [],
    ),
  );
}

export function QueuedRunsControl({
  ref,
  ...props
}: {
  readonly ref?: Ref<QueuedRunsControlHandle>;
  readonly steerShortcutLabel?: string | null;
  readonly editShortcutLabel?: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments">
  >;
  readonly editingRunId: RunId | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
  readonly onCancelEdit: () => void;
}) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const editQueued = useAtomCommand(threadEnvironment.editQueuedRun, "merge queued messages");
  const holdQueue = useAtomCommand(threadEnvironment.holdThreadQueue, "pause queue");
  const resumeQueue = useAtomCommand(threadEnvironment.resumeThreadQueue, "resume queue");
  const clearQueue = useAtomCommand(threadEnvironment.clearThreadQueue, "clear queue");
  const restoreQueue = useAtomCommand(serverEnvironment.clearAllQueues, "restore queue");
  const [expanded, setExpanded] = useState(true);
  const queueListId = useId();
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const [dragState, setDragState] = useState<{
    readonly runId: RunId;
    readonly insertIndex: number | null;
  } | null>(null);
  // Drags must start from the grip, not from an accidental text-drag on the
  // row. The grip arms its run id on pointerdown; dragstart verifies it.
  const dragArmedRunIdRef = useRef<RunId | null>(null);
  const steerInFlightRef = useRef(false);
  // Once the projection holds the message the optimistic copy is stale no
  // matter what happened to its run — keying on still-queued runs alone would
  // resurrect a phantom "pending" row after the run is cancelled or started.
  const acknowledgedMessageIds = new Set((projection?.messages ?? []).map((message) => message.id));
  const queuedImageAttachmentResources = queuedImageResources(projection);
  // The environment-wide pause holds this queue too, whatever the thread says.
  const allQueuesPaused = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.threadQueuesPaused,
  );
  const queuedImageAttachmentUrls = useAssetUrls(
    props.environmentId,
    queuedImageAttachmentResources,
  );
  const workflow = projection ? deriveThreadQueueWorkflowState(projection) : null;
  const queued = workflow?.queuedRuns ?? [];
  const activeRun = workflow?.activeRun ?? null;
  const canReorder = workflow?.canReorder === true;
  const queueHeld = workflow?.isHeld === true;
  const queuedImageUrlById = new Map(
    queuedImageAttachmentUrls.flatMap((url, index) => {
      const resource = queuedImageAttachmentResources[index];
      return url && resource ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  const optimisticQueued = props.optimisticMessages.filter(
    (message) => message.inputIntent === "queued_turn" && !acknowledgedMessageIds.has(message.id),
  );
  const items = [
    ...queued.map(({ run, text, attachments }, serverIndex) => ({
      key: run.id,
      runId: run.id,
      messageId: run.userMessageId,
      serverIndex,
      text,
      attachments,
      thumbnails: attachments
        .filter((attachment) => attachment.type === "image")
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: queuedImageUrlById.get(attachment.id) ?? null,
        })),
      pending: false,
    })),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      runId: null,
      messageId: null,
      serverIndex: null,
      text: message.text,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      thumbnails: (message.attachments ?? [])
        .filter(isImageAttachment)
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: attachment.previewUrl ?? null,
        })),
      pending: true,
    })),
  ];

  const move = async (runId: RunId, beforeRunId: RunId | null) => {
    setBusyRunId(runId);
    await reorder({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId, beforeRunId },
    });
    setBusyRunId(null);
  };

  const completeDrag = (runId: RunId, insertIndex: number | null) => {
    setDragState(null);
    dragArmedRunIdRef.current = null;
    if (insertIndex === null || busyRunId !== null) return;
    const draggedIndex = queued.findIndex(({ run }) => run.id === runId);
    if (draggedIndex === -1) return;
    if (insertIndex === draggedIndex || insertIndex === draggedIndex + 1) return;
    void move(runId, queued[insertIndex]?.run.id ?? null);
  };

  const steer = async (queuedRunId: RunId) => {
    if (activeRun === null || !workflow?.canPromoteToSteer || steerInFlightRef.current) return;
    steerInFlightRef.current = true;
    setBusyRunId(queuedRunId);
    await promote({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
    });
    steerInFlightRef.current = false;
    setBusyRunId(null);
  };

  // With no run under way there is nothing to steer: the message starts as
  // the thread's next turn instead, also while the queue is held or all queues
  // are paused. Whatever else waits stays under the global pause.
  const sendNow = async (queuedRunId: RunId) => {
    if (activeRun !== null || steerInFlightRef.current) return;
    steerInFlightRef.current = true;
    // The commands settle into results instead of throwing, so no `try` is needed.
    const first = queued[0]?.run.id;
    if (first !== undefined && first !== queuedRunId) await move(queuedRunId, first);
    setBusyRunId(queuedRunId);
    await resumeQueue({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, startNextDespitePause: true },
    });
    steerInFlightRef.current = false;
    setBusyRunId(null);
  };

  useImperativeHandle(ref, () => ({
    steerNext(repeat) {
      const next = queued[0];
      if (!next) return false;
      if (activeRun === null) {
        if (!repeat && busyRunId === null) void sendNow(next.run.id);
        return true;
      }
      if (!workflow?.canPromoteToSteer) return false;
      if (!repeat && busyRunId === null) void steer(next.run.id);
      return true;
    },
    // Declines while a queued message is already being edited so the key keeps
    // moving the caret inside that draft.
    editLatest(repeat) {
      const latest = queued.at(-1);
      if (!latest || props.editingRunId !== null || busyRunId !== null) return false;
      if (!repeat) {
        setExpanded(true);
        props.onEditQueuedRun({
          runId: latest.run.id,
          messageId: latest.run.userMessageId,
          text: latest.text,
          attachments: latest.attachments,
        });
      }
      return true;
    },
  }));

  if (items.length === 0) return null;

  // The first message takes every text in queue order and the others leave the
  // queue, so they run as one turn. Nothing is removed unless the edit landed.
  const merge = async () => {
    const [first, ...rest] = queued;
    if (first === undefined || busyRunId !== null || !canMergeQueuedMessages(queued)) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Merge the ${queued.length} queued messages into one? They run as one turn, in this order.`,
    );
    if (!confirmed) return;
    setBusyRunId(first.run.id);
    // The commands settle into results instead of throwing, so no `try` is needed.
    const edited = await editQueued({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        runId: first.run.id,
        text: mergeQueuedMessageTexts(queued),
      },
    });
    if (edited._tag !== "Success") {
      setBusyRunId(null);
      return;
    }
    const kept = await removeMergedQueuedRuns(
      rest.map(({ run }) => run.id),
      (runId) =>
        cancel({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, runId },
        }),
    );
    setBusyRunId(null);
    toastManager.add(
      kept.length === 0
        ? { type: "success", title: `Merged ${queued.length} queued messages into one` }
        : {
            type: "warning",
            title: `Merged, but ${kept.length} of ${rest.length} messages could not be removed`,
            description: "They are still in the queue and would run again. Remove them by hand.",
          },
    );
  };

  const remove = async (runId: RunId) => {
    setBusyRunId(runId);
    await cancel({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId },
    });
    setBusyRunId(null);
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
        aria-live="polite"
        data-chat-composer-collapsed-controls="true"
        className="relative z-0"
      >
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-label={expanded ? "Collapse queued messages" : "Expand queued messages"}
          aria-expanded={expanded}
          aria-controls={queueListId}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setExpanded((value) => !value)}
        >
          <ComposerBanner.Icon>
            <ListOrderedIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">
            {allQueuesPaused
              ? "Queued, all queues paused"
              : queueHeld
                ? "Queued, paused"
                : "Queued"}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{items.length}</ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <ComposerBanner.Scroll className={cn("max-h-32", !expanded && "hidden")}>
          <ComposerBanner.Children render={<ol />} id={queueListId}>
            {queued.length > 0 ? (
              <ComposerBanner.Row render={<li />}>
                <ComposerBanner.Content className="text-muted-foreground">
                  {allQueuesPaused
                    ? "All queues are paused. Send now starts one message here; the sidebar resumes all queues."
                    : queueHeld
                      ? "Nothing here starts until you resume."
                      : "Pausing lets the current run finish and holds the rest."}
                </ComposerBanner.Content>
                <ComposerBanner.Actions>
                  {/* The pause of all queues is lifted where it is shown for all threads, in the
                      sidebar, not from inside one thread. */}
                  {allQueuesPaused ? null : (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void (queueHeld ? resumeQueue : holdQueue)({
                          environmentId: props.environmentId,
                          input: { threadId: props.threadId },
                        })
                      }
                    >
                      {queueHeld ? "Resume queue" : "Pause queue"}
                    </Button>
                  )}
                  {canMergeQueuedMessages(queued) && props.editingRunId === null ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busyRunId !== null}
                      onClick={() => void merge()}
                    >
                      Merge into one
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      void ensureLocalApi()
                        .dialogs.confirm(
                          `Remove ${queued.length === 1 ? "the queued message" : `all ${queued.length} queued messages`} from this thread? The current run goes on.`,
                          { variant: "destructive" },
                        )
                        .then(async (confirmed) => {
                          if (!confirmed) return;
                          const count = queued.length;
                          const result = await clearQueue({
                            environmentId: props.environmentId,
                            input: { threadId: props.threadId },
                          });
                          if (result._tag !== "Success") return;
                          const toastId = toastManager.add({
                            type: "success",
                            title: `Removed ${count} queued ${count === 1 ? "message" : "messages"}`,
                            actionProps: {
                              children: "Undo",
                              onClick: () => {
                                toastManager.close(toastId);
                                void restoreQueue({
                                  environmentId: props.environmentId,
                                  input: {
                                    commandId: CommandId.make(randomUUID()),
                                    restore: { threadId: props.threadId, maxAgeMinutes: 60 },
                                  },
                                }).then((restored) => {
                                  if (
                                    restored._tag === "Success" &&
                                    (restored.value.heldBack ?? 0) > 0
                                  ) {
                                    toastManager.add({
                                      type: "info",
                                      title: "Not put back yet",
                                      description:
                                        'All queues are paused and this thread stands still, so the messages would start at once. Turn off "Pause all queues", then use Restore cleared in Settings.',
                                    });
                                  }
                                });
                              },
                            },
                          });
                        });
                    }}
                  >
                    Clear queue
                  </Button>
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
            ) : null}
            {items.map((item) => {
              const previewText = assistantCitationsToPlainText(
                replaceComposerContextReferences(item.text, (reference) =>
                  reference.kind === "image" && item.thumbnails.length > 0 ? "" : reference.label,
                ),
              ).trim();
              const rowRunId = item.runId;
              const rowServerIndex = item.serverIndex;
              const isEditing = rowRunId !== null && rowRunId === props.editingRunId;
              const rowDraggable =
                rowRunId !== null && rowServerIndex !== null && canReorder && busyRunId === null;
              return (
                <ComposerBanner.Row
                  render={<li />}
                  key={item.key}
                  aria-current={isEditing ? "true" : undefined}
                  className={cn(
                    "relative rounded-sm",
                    isEditing && "bg-accent text-accent-foreground",
                    dragState !== null && dragState.runId === item.runId && "opacity-50",
                  )}
                  draggable={rowDraggable}
                  onDragStart={(event) => {
                    if (item.runId === null || dragArmedRunIdRef.current !== item.runId) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData(QUEUED_RUN_DRAG_TYPE, item.runId);
                    event.dataTransfer.effectAllowed = "move";
                    setDragState({ runId: item.runId, insertIndex: null });
                  }}
                  onDragEnd={() => {
                    dragArmedRunIdRef.current = null;
                    setDragState(null);
                  }}
                  onDragOver={(event) => {
                    if (dragState === null || item.serverIndex === null) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect = event.currentTarget.getBoundingClientRect();
                    const insertIndex =
                      event.clientY < rect.top + rect.height / 2
                        ? item.serverIndex
                        : item.serverIndex + 1;
                    if (dragState.insertIndex !== insertIndex) {
                      setDragState({ runId: dragState.runId, insertIndex });
                    }
                  }}
                  onDrop={(event) => {
                    if (dragState === null) return;
                    event.preventDefault();
                    completeDrag(dragState.runId, dragState.insertIndex);
                  }}
                >
                  {item.serverIndex !== null && dragState?.insertIndex === item.serverIndex ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded bg-primary/70"
                    />
                  ) : null}
                  {item.serverIndex === queued.length - 1 &&
                  dragState?.insertIndex === queued.length ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded bg-primary/70"
                    />
                  ) : null}
                  <ComposerBanner.Icon aria-hidden={false}>
                    {canReorder && rowRunId !== null && rowServerIndex !== null ? (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Reorder queued message (drag, or press the arrow keys)"
                        className="cursor-grab active:cursor-grabbing disabled:cursor-default"
                        disabled={busyRunId !== null}
                        onPointerDown={() => {
                          dragArmedRunIdRef.current = rowRunId;
                        }}
                        onKeyDown={(event) => {
                          if (busyRunId !== null) return;
                          if (event.key === "ArrowUp" && rowServerIndex > 0) {
                            event.preventDefault();
                            void move(rowRunId, queued[rowServerIndex - 1]?.run.id ?? null);
                          }
                          if (event.key === "ArrowDown" && rowServerIndex < queued.length - 1) {
                            event.preventDefault();
                            void move(rowRunId, queued[rowServerIndex + 2]?.run.id ?? null);
                          }
                        }}
                      >
                        <GripVerticalIcon />
                      </Button>
                    ) : null}
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content className="text-foreground/80">
                    {isEditing ? <span className="sr-only">Editing queued message: </span> : null}
                    {item.pending ? (
                      <Clock3Icon
                        aria-label="Saving queued message"
                        className="size-3 shrink-0 text-muted-foreground/60"
                      />
                    ) : null}
                    {item.thumbnails.length > 0 ? (
                      <span className="flex shrink-0 items-center gap-0.5">
                        {item.thumbnails.map((thumbnail) => (
                          <span
                            key={thumbnail.key}
                            className="size-4 overflow-hidden rounded border border-border/70 bg-background"
                          >
                            {thumbnail.url ? (
                              <img
                                src={thumbnail.url}
                                alt={thumbnail.name}
                                className="size-full object-cover"
                              />
                            ) : (
                              <span
                                aria-label={thumbnail.name}
                                className="block size-full bg-muted/60"
                              />
                            )}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    <Tooltip>
                      <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                        {previewText}
                      </TooltipTrigger>
                      <TooltipPopup side="top" className="max-w-96 break-words">
                        {previewText}
                      </TooltipPopup>
                    </Tooltip>
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    {isEditing ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label="Cancel editing queued message"
                        onClick={props.onCancelEdit}
                      >
                        Cancel
                      </Button>
                    ) : (
                      <>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                aria-label="Edit queued message"
                                disabled={item.runId === null || busyRunId !== null}
                                onClick={() => {
                                  if (item.runId !== null && item.messageId !== null) {
                                    props.onEditQueuedRun({
                                      runId: item.runId,
                                      messageId: item.messageId,
                                      text: item.text,
                                      attachments: item.attachments,
                                    });
                                  }
                                }}
                              />
                            }
                          >
                            <PencilIcon />
                          </TooltipTrigger>
                          <TooltipPopup>
                            {`Edit in the composer${item.serverIndex === queued.length - 1 && props.editShortcutLabel ? ` (${props.editShortcutLabel})` : ""}`}
                          </TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger render={<span className="flex shrink-0" />}>
                            <Button
                              size="xs"
                              variant="ghost-muted"
                              disabled={
                                item.runId === null ||
                                busyRunId !== null ||
                                (activeRun !== null && !workflow?.canPromoteToSteer)
                              }
                              onClick={() => {
                                if (item.runId !== null) {
                                  void (activeRun === null ? sendNow : steer)(item.runId);
                                }
                              }}
                            >
                              <CornerUpRightIcon />
                              {activeRun === null ? "Send now" : "Steer"}
                            </Button>
                          </TooltipTrigger>
                          <TooltipPopup>
                            {activeRun === null
                              ? allQueuesPaused
                                ? "Start this message now. The rest waits while all queues are paused."
                                : "Start this message now"
                              : `Send as a steer instead${item.serverIndex === 0 && props.steerShortcutLabel ? ` (${props.steerShortcutLabel})` : ""}`}
                          </TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <ComposerBanner.Dismiss
                                aria-label="Remove queued message"
                                disabled={item.runId === null || busyRunId !== null}
                                onClick={() => {
                                  if (item.runId !== null) void remove(item.runId);
                                }}
                              />
                            }
                          />
                          <TooltipPopup>Remove from queue</TooltipPopup>
                        </Tooltip>
                      </>
                    )}
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              );
            })}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
