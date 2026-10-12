import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadChecklistItem } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { serverEnvironment } from "../state/server";
import type { OpenThreadFilter, OpenThreadSummary } from "./Sidebar.logic";
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
  filter,
  onFilter,
  queueFilterOn,
  onQueueFilter,
  onOpenChecklists,
}: {
  readonly summary: OpenThreadSummary;
  /** The environment whose usage history feeds the burn chart; null hides the chart. */
  readonly environmentId: EnvironmentId | null;
  readonly nowMs: number;
  /** The group the thread list is narrowed to; null shows every open thread. */
  readonly filter: OpenThreadFilter | null;
  readonly onFilter: (filter: OpenThreadFilter | null) => void;
  /** Whether the list is narrowed to the threads with a waiting queue. */
  readonly queueFilterOn: boolean;
  /** Narrows the list to these threads; null shows every thread again. */
  readonly onQueueFilter: (threadIds: ReadonlySet<string> | null) => void;
  /** Opens the checklists of all open threads on the given group of items. */
  readonly onOpenChecklists: (status: ThreadChecklistItem["status"]) => void;
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
            {summary.open} open · {summary.working + summary.waiting} active · {summary.needYou}{" "}
            need you
            {filter === null ? "" : ` · list shows ${FILTER_LABEL[filter].toLowerCase()} only`}
          </span>
        )}
      </button>
      {expanded ? (
        <div className="mt-1 flex flex-col gap-1.5">
          <div className="grid grid-cols-4 gap-1">
            <CockpitStat
              label="Open"
              value={summary.open}
              pressed={filter === null}
              onClick={() => onFilter(null)}
            />
            {/* "Active", not "Working": the count also holds threads that wait on
                background work, whose rows say "Waiting". */}
            <CockpitStat
              label="Active"
              value={summary.working + summary.waiting}
              pressed={filter === "working"}
              onClick={() => onFilter(filter === "working" ? null : "working")}
            />
            <CockpitStat
              label="Need you"
              value={summary.needYou}
              emphasis={summary.needYou > 0}
              pressed={filter === "needYou"}
              onClick={() => onFilter(filter === "needYou" ? null : "needYou")}
            />
            <CockpitStat
              label="Idle"
              value={summary.idle}
              pressed={filter === "idle"}
              onClick={() => onFilter(filter === "idle" ? null : "idle")}
            />
          </div>
          {filter === null ? null : (
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-sidebar-foreground">
                List shows {FILTER_LABEL[filter].toLowerCase()} only
              </span>
              <button
                type="button"
                onClick={() => onFilter(null)}
                className="cursor-pointer rounded-sm underline underline-offset-2 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
              >
                show all
              </button>
            </div>
          )}
          <div className="tabular-nums">
            {summary.open === 0
              ? "No open threads."
              : `${blockedShare}% of open threads wait on you` +
                (summary.waiting > 0 ? ` · ${summary.waiting} on background work` : "")}
          </div>
          {environmentId === null ? null : (
            <CockpitWaitingQueues
              environmentId={environmentId}
              nowMs={nowMs}
              filterOn={queueFilterOn}
              onFilter={onQueueFilter}
            />
          )}
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

const FILTER_LABEL: Record<OpenThreadFilter, string> = {
  working: "Active",
  needYou: "Need you",
  idle: "Idle",
};

/** One count; a click narrows the thread list to that group. */
function CockpitStat(props: {
  readonly label: string;
  readonly value: number;
  readonly emphasis?: boolean;
  readonly pressed: boolean;
  readonly onClick: () => void;
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
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className="flex min-w-0 cursor-pointer flex-col items-start rounded-sm bg-sidebar-row-hover/60 px-1.5 py-1 text-left hover:bg-sidebar-row-hover hover:ring-1 hover:ring-sidebar-foreground/20 hover:ring-inset focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset aria-pressed:bg-sidebar-row-hover aria-pressed:ring-1 aria-pressed:ring-sidebar-foreground/30 aria-pressed:ring-inset"
    >
      {body}
    </button>
  );
}

const STALE_QUEUE_MS = 60 * 60_000;
/** A run under way with no event for this long is called out. */
const QUIET_RUN_MS = 5 * 60_000;

function waitLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 10 ? `${hours.toFixed(1)} h` : `${Math.round(hours)} h`;
}

/**
 * Messages that wait in the queues of open threads, and for how long the
 * oldest has waited. A queue behind a pause or a hold is otherwise silent.
 * A click narrows the thread list to the threads concerned.
 */
function CockpitWaitingQueues({
  environmentId,
  nowMs,
  filterOn,
  onFilter,
}: {
  readonly environmentId: EnvironmentId;
  readonly nowMs: number;
  readonly filterOn: boolean;
  readonly onFilter: (threadIds: ReadonlySet<string> | null) => void;
}) {
  const input = useMemo(() => ({}), []);
  const result = useAtomValue(serverEnvironment.threadChecklists({ environmentId, input }));
  const queues = Option.getOrNull(AsyncResult.value(result))?.waitingQueues ?? [];
  const quiet = (Option.getOrNull(AsyncResult.value(result))?.activeRuns ?? []).filter(
    (run) => nowMs - Date.parse(run.lastEventAt) >= QUIET_RUN_MS,
  );
  const quietLine =
    quiet.length === 0 ? null : (
      <button
        type="button"
        data-testid="sidebar-cockpit-quiet"
        onClick={() => onFilter(new Set(quiet.map((run) => run.threadId)))}
        className="cursor-pointer self-start rounded-sm text-left font-medium tabular-nums text-warning-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        {quiet.length} running {quiet.length === 1 ? "turn" : "turns"} without a sign of life for{" "}
        {waitLabel(nowMs - Math.min(...quiet.map((run) => Date.parse(run.lastEventAt))))}
      </button>
    );
  if (queues.length === 0) {
    return (
      <>
        {quietLine}
        {filterOn ? (
          <button
            type="button"
            onClick={() => onFilter(null)}
            className="cursor-pointer self-start rounded-sm underline underline-offset-2 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
          >
            List shows selected threads only · show all
          </button>
        ) : null}
      </>
    );
  }
  const waiting = queues.reduce((total, queue) => total + queue.waiting, 0);
  const oldestMs = nowMs - Date.parse(queues[0]!.oldestQueuedAt);
  return (
    <>
      {quietLine}
      <button
        type="button"
        data-testid="sidebar-cockpit-queues"
        aria-pressed={filterOn}
        onClick={() => onFilter(filterOn ? null : new Set(queues.map((queue) => queue.threadId)))}
        className="cursor-pointer self-start rounded-sm text-left tabular-nums hover:text-sidebar-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        <span
          className={oldestMs >= STALE_QUEUE_MS ? "font-medium text-warning-foreground" : undefined}
        >
          {waiting} {waiting === 1 ? "message waits" : "messages wait"} in {queues.length}{" "}
          {queues.length === 1 ? "thread" : "threads"}, oldest {waitLabel(oldestMs)}
        </span>
        {filterOn ? " · show all" : ""}
      </button>
    </>
  );
}

/** What the stored checklists of the open threads add up to; opens the full list. */
function CockpitChecklists({
  environmentId,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly onOpen: (status: ThreadChecklistItem["status"]) => void;
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
  const part =
    "cursor-pointer rounded-sm tabular-nums hover:text-sidebar-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset";
  if (checklists === null || checklists.length === 0) {
    return (
      <button
        type="button"
        data-testid="sidebar-cockpit-checklists"
        onClick={() => onOpen("attention")}
        className={`${part} self-start text-left`}
      >
        Checklists of all threads
      </button>
    );
  }
  // Each count opens the list on its own group of items.
  return (
    <div data-testid="sidebar-cockpit-checklists" className="flex flex-wrap gap-x-1.5">
      <button
        type="button"
        onClick={() => onOpen("attention")}
        className={`${part} ${attention > 0 ? "font-medium text-destructive" : ""}`}
      >
        {attention} {attention === 1 ? "point needs" : "points need"} you
      </button>
      <button type="button" onClick={() => onOpen("open")} className={part}>
        {count("open")} open
      </button>
      <button type="button" onClick={() => onOpen("backlog")} className={part}>
        {count("backlog")} backlog
      </button>
      <button type="button" onClick={() => onOpen("done")} className={part}>
        {count("done")} done
      </button>
    </div>
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
  const navigate = useNavigate();
  if (burn === null || history === null || history.points.length === 0) return null;
  const scale = Math.max(burn.peak, 1);
  const barWidth = 100 / BURN_HOURS;
  return (
    // The numbers behind the bars live on the Usage page; a click goes there.
    <button
      type="button"
      onClick={() => void navigate({ to: "/usage" })}
      aria-label="Open usage"
      className="flex cursor-pointer items-end gap-2 rounded-sm text-left hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      data-testid="sidebar-cockpit-burn"
    >
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
    </button>
  );
}
