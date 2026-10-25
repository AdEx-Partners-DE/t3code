import type { HandoffTimelineRun } from "./V2LifecycleRow";
import type { ServerProvider } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";

export const MESSAGE_HEADING_LEVEL = 3;

export function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

export function TimelineRowTimestamp({
  createdAt,
  timestampFormat,
  className,
  alwaysVisible = false,
  detail,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
  className?: string;
  alwaysVisible?: boolean;
  /** A second line for the tooltip, e.g. the model and account a turn ran on. */
  detail?: string | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
              alwaysVisible && "pointer-events-auto static opacity-100",
              className,
            )}
          />
        }
      >
        {formatDayAwareTimestamp(createdAt, timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>
        {formatChatTimestampTooltip(createdAt, timestampFormat)}
        {detail ? (
          <>
            <br />
            {detail}
          </>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

/** The model and account a run worked on, in the names the model picker uses. */
export function runModelAndAccount(
  run: Pick<HandoffTimelineRun, "providerInstanceId" | "modelSelection"> | undefined,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "displayName" | "models">>,
): string | undefined {
  if (run === undefined) return undefined;
  const provider = providers.find((candidate) => candidate.instanceId === run.providerInstanceId);
  const model =
    provider?.models.find((candidate) => candidate.slug === run.modelSelection.model)?.name ??
    run.modelSelection.model;
  return `${model} · ${provider?.displayName ?? run.providerInstanceId}`;
}
