import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { serverEnvironment } from "../../state/server";
import { buildUsageLimitTrend } from "./usageLimitTrend";

const PERIOD_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });

const resetTimeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * How each account's allowance was used over the last week, and what every
 * reset left unused. Shows nothing until the environment has recorded a
 * reading, so an environment without the history costs no space.
 */
export function UsageLimitTrendSection({
  environmentId,
  providers,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly now: number;
}) {
  // Whole days, so the query key holds still between renders.
  const sinceMs = Math.floor(now / DAY_MS) * DAY_MS - (PERIOD_DAYS - 1) * DAY_MS;
  const input = useMemo(() => ({ since: new Date(sinceMs).toISOString() }), [sinceMs]);
  const result = useAtomValue(serverEnvironment.usageLimitHistory({ environmentId, input }));
  const history = Option.getOrNull(AsyncResult.value(result));
  if (history === null) return null;
  const accounts = buildUsageLimitTrend({ history, providers, sinceMs, nowMs: now });
  if (accounts.length === 0) return null;
  // One mark per day boundary inside the period, and the weekday of each day.
  const dayMarks = Array.from({ length: PERIOD_DAYS }, (_, index) => index)
    .map((index) => ((sinceMs + index * DAY_MS - sinceMs) / (now - sinceMs)) * 100)
    .filter((x) => x > 0 && x < 100);
  const dayLabels = Array.from({ length: PERIOD_DAYS }, (_, index) =>
    weekdayFormat.format(new Date(sinceMs + index * DAY_MS + DAY_MS / 2)),
  );
  const unusedTotal = accounts.reduce(
    (total, account) => total + account.lines.reduce((sum, line) => sum + line.unusedAtResets, 0),
    0,
  );
  return (
    <section className="flex flex-col gap-3" data-testid="usage-limit-trend">
      <h2 className="text-sm font-medium text-foreground">
        Last {PERIOD_DAYS} days
        <span className="ml-2 font-normal text-muted-foreground">
          recorded since this environment started keeping history
        </span>
      </h2>
      <p className="text-xs text-muted-foreground">
        The line falls as an allowance is used; a dashed red line is a reset.
        {unusedTotal > 0
          ? ` At the resets in this period ${Math.round(unusedTotal)} percentage points of weekly or monthly allowance went unused across all accounts.`
          : " No weekly or monthly allowance went unused at a reset in this period."}
      </p>
      <div className="grid gap-3">
        {accounts.map((account) => (
          <div
            key={account.instanceId}
            className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
          >
            <h3 className="truncate text-sm font-medium text-foreground">{account.name}</h3>
            {account.lines.map((line) => (
              <div key={line.windowId} className="flex flex-wrap items-center gap-x-3">
                <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
                  {line.label}
                </span>
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={`${line.label}: ${Math.round(line.remainingPercent)}% left`}
                  className="h-16 min-w-0 flex-1 rounded-sm bg-muted/40 text-foreground/70"
                >
                  {dayMarks.map((x) => (
                    <line
                      key={`day:${x}`}
                      x1={x}
                      x2={x}
                      y1="0"
                      y2="100"
                      stroke="currentColor"
                      strokeWidth="1"
                      opacity="0.15"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  {line.resetMarks.map((x) => (
                    <line
                      key={`reset:${x}`}
                      x1={x}
                      x2={x}
                      y1="0"
                      y2="100"
                      className="text-destructive"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeDasharray="3 3"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  <polyline
                    points={line.path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-foreground">
                  {Math.round(line.remainingPercent)}% left
                </span>
                <span className="basis-full pl-31 text-xs text-muted-foreground tabular-nums">
                  {line.usedPerDay
                    .map((value, index) => `${dayLabels[index] ?? ""} ${Math.round(value)}`)
                    .join(" · ")}{" "}
                  points used per day
                  {line.resetMarks.length > 0
                    ? ` · ${Math.round(line.unusedAtResets)} points unused at ${line.resetMarks.length === 1 ? "the reset" : `${line.resetMarks.length} resets`}`
                    : ""}
                </span>
                {line.forecast ? (
                  <span
                    className={
                      line.forecast.type === "runs-out"
                        ? "basis-full pl-31 text-xs text-warning-foreground"
                        : "basis-full pl-31 text-xs text-muted-foreground"
                    }
                  >
                    {line.forecast.type === "runs-out"
                      ? `At this pace empty ${resetTimeFormat.format(new Date(line.forecast.at))}, before the reset ${resetTimeFormat.format(new Date(line.forecast.resetsAt))}`
                      : `At this pace ${line.forecast.unusedPercent}% stays unused at the reset ${resetTimeFormat.format(new Date(line.forecast.resetsAt))}`}
                  </span>
                ) : null}
              </div>
            ))}
            {account.resets.length > 0 ? (
              <ul className="flex flex-col gap-1 border-t border-border/60 pt-2 text-xs text-muted-foreground">
                {account.resets.map((reset) => (
                  <li key={`${reset.windowId}:${reset.at}`} className="flex flex-wrap gap-x-2">
                    <span className="tabular-nums">
                      {resetTimeFormat.format(new Date(reset.at))}
                    </span>
                    <span>{reset.label} reset</span>
                    <span className="text-foreground">
                      {Math.round(reset.unusedPercentBefore)}% unused
                    </span>
                    {reset.ahead ? (
                      <span>
                        early
                        {reset.expectedAt
                          ? `, was due ${resetTimeFormat.format(new Date(reset.expectedAt))}`
                          : ""}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
