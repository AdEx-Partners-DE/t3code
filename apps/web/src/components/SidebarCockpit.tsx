import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { serverEnvironment } from "../state/server";
import type { OpenThreadSummary } from "./Sidebar.logic";
import { buildUsageBurn } from "./usage/usageBurn";

const COCKPIT_EXPANDED_KEY = "t3code:sidebar:cockpit-expanded";
const BURN_HOURS = 24;
const HOUR_MS = 60 * 60_000;

/**
 * The state of all open threads at a glance, above the thread list: how many
 * are open, working, waiting on the user or idle, and how fast the accounts
 * are using their allowance. Folds to one line.
 */
export function SidebarCockpit({
  summary,
  environmentId,
  nowMs,
  onOpenNextWaiting,
  onOpenChecklists,
}: {
  readonly summary: OpenThreadSummary;
  /** The environment whose usage history feeds the burn chart; null hides the chart. */
  readonly environmentId: EnvironmentId | null;
  readonly nowMs: number;
  readonly onOpenNextWaiting: () => void;
  /** Opens the checklists of all open threads. */
  readonly onOpenChecklists: () => void;
}) {
  const [expanded, setExpanded] = useLocalStorage(COCKPIT_EXPANDED_KEY, true, Schema.Boolean);
  const blockedShare = summary.open === 0 ? 0 : Math.round((summary.needYou / summary.open) * 100);
  return (
    <div data-testid="sidebar-cockpit" className="mx-0.5 px-2 pb-1 text-2xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-1 rounded-sm text-left hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        {expanded ? (
          <ChevronDownIcon className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0" />
        )}
        <span className="font-medium">Cockpit</span>
        {expanded ? null : (
          <span className="min-w-0 truncate tabular-nums">
            {summary.open} open · {summary.working} working · {summary.needYou} need you
          </span>
        )}
      </button>
      {expanded ? (
        <div className="mt-1 flex flex-col gap-1.5">
          <div className="grid grid-cols-4 gap-1">
            <CockpitStat label="Open" value={summary.open} />
            <CockpitStat label="Working" value={summary.working + summary.waiting} />
            <CockpitStat
              label="Need you"
              value={summary.needYou}
              emphasis={summary.needYou > 0}
              onClick={summary.needYou > 0 ? onOpenNextWaiting : undefined}
            />
            <CockpitStat label="Idle" value={summary.idle} />
          </div>
          <div className="tabular-nums">
            {summary.open === 0
              ? "No open threads."
              : `${blockedShare}% of open threads wait on you` +
                (summary.waiting > 0 ? ` · ${summary.waiting} on background work` : "")}
          </div>
          {environmentId === null ? null : (
            <CockpitChecklists environmentId={environmentId} onOpen={onOpenChecklists} />
          )}
          {environmentId === null ? null : (
            <CockpitBurn environmentId={environmentId} nowMs={nowMs} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function CockpitStat(props: {
  readonly label: string;
  readonly value: number;
  readonly emphasis?: boolean;
  readonly onClick?: (() => void) | undefined;
}) {
  const body = (
    <>
      <span
        className={
          props.emphasis
            ? "text-sm font-semibold tabular-nums text-primary"
            : "text-sm font-semibold tabular-nums text-sidebar-foreground"
        }
      >
        {props.value}
      </span>
      <span className="truncate">{props.label}</span>
    </>
  );
  const className =
    "flex min-w-0 flex-col items-start rounded-sm bg-sidebar-row-hover/60 px-1.5 py-1";
  return props.onClick ? (
    <button
      type="button"
      onClick={props.onClick}
      className={`${className} cursor-pointer text-left hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset`}
    >
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** What the stored checklists of the open threads add up to; opens the full list. */
function CockpitChecklists({
  environmentId,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly onOpen: () => void;
}) {
  const input = useMemo(() => ({}), []);
  const result = useAtomValue(serverEnvironment.threadChecklists({ environmentId, input }));
  const checklists = Option.getOrNull(AsyncResult.value(result))?.checklists ?? null;
  const count = (status: string) =>
    (checklists ?? []).reduce(
      (total, checklist) => total + checklist.items.filter((item) => item.status === status).length,
      0,
    );
  const attention = count("attention");
  return (
    <button
      type="button"
      data-testid="sidebar-cockpit-checklists"
      onClick={onOpen}
      className="cursor-pointer rounded-sm text-left tabular-nums hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
    >
      {checklists === null || checklists.length === 0 ? (
        "Checklists of all threads"
      ) : (
        <>
          <span className={attention > 0 ? "font-medium text-destructive" : undefined}>
            {attention} {attention === 1 ? "point needs" : "points need"} you
          </span>{" "}
          · {count("open")} open · {count("done")} done
        </>
      )}
    </button>
  );
}

/** Allowance used per hour over the last day, as bars, with the last hour's rate in words. */
function CockpitBurn({
  environmentId,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly nowMs: number;
}) {
  // Whole hours, so the query key holds still between renders.
  const sinceMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS - BURN_HOURS * HOUR_MS;
  const input = useMemo(() => ({ since: new Date(sinceMs).toISOString() }), [sinceMs]);
  const result = useAtomValue(serverEnvironment.usageLimitHistory({ environmentId, input }));
  const history = Option.getOrNull(AsyncResult.value(result));
  const burn = useMemo(
    () =>
      history === null
        ? null
        : buildUsageBurn({ points: history.points, nowMs, hours: BURN_HOURS }),
    [history, nowMs],
  );
  if (burn === null || history === null || history.points.length === 0) return null;
  const scale = Math.max(burn.peak, 1);
  const barWidth = 100 / BURN_HOURS;
  return (
    <div className="flex items-end gap-2" data-testid="sidebar-cockpit-burn">
      <svg
        viewBox="0 0 100 24"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Allowance used per hour over the last ${BURN_HOURS} hours`}
        className="h-6 min-w-0 flex-1 text-sidebar-foreground/60"
      >
        {burn.perHour.map((value, index) => {
          const height = Math.max(value > 0 ? 1.5 : 0.5, (value / scale) * 24);
          return (
            <rect
              // Bars are positional; the hour is the identity.
              key={index}
              x={index * barWidth + 0.4}
              y={24 - height}
              width={barWidth - 0.8}
              height={height}
              fill="currentColor"
              opacity={value > 0 ? 1 : 0.35}
            />
          );
        })}
      </svg>
      <span className="shrink-0 text-right tabular-nums">
        <span className="font-medium text-sidebar-foreground">
          {burn.lastHour.toFixed(burn.lastHour >= 10 ? 0 : 1)}
        </span>{" "}
        pts/h
      </span>
    </div>
  );
}
