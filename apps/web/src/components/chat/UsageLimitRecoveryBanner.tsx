import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import type { LimitSwitchTarget } from "@t3tools/client-runtime/state/limit-switch-targets";
import { GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  /** Other accounts that can take this thread over now; see `listLimitSwitchTargets`. */
  switchTargets: ReadonlyArray<LimitSwitchTarget>;
  onSwitch: (target: LimitSwitchTarget) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, stoppedAt } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    priority: "urgent",
    icon: <GaugeIcon />,
    title: "Usage limit reached",
    description: resetAt
      ? `Resets ${new Date(resetAt).toLocaleString()}`
      : "Reset time unavailable; retry manually",
    actions:
      canSchedule || props.switchTargets.length > 0 ? (
        <RecoveryActions key={`${runId}:${resetAt}`} canSchedule={canSchedule} {...props} />
      ) : null,
  };
}

function RecoveryActions({
  runId,
  resetAt,
  recovery,
  snoozedUntil,
  onChange,
  switchTargets,
  onSwitch,
  canSchedule,
}: RecoveryProps & { canSchedule: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const delay = Date.parse(resetAt ?? "") - Math.max(nowMs, Date.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetAt, nowMs]);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt);
  async function run(change: () => Promise<void>, fallback: string) {
    setPending(true);
    setError(null);
    try {
      await change();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    }
    setPending(false);
  }
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      setNowMs(Date.now());
      return;
    }
    await run(
      () =>
        onChange({
          runId,
          resetAt,
          ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
        }),
      "Could not change limit recovery.",
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {switchTargets.map((target) => (
        <Button
          key={target.selection.instanceId}
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            void run(() => onSwitch(target), `Could not continue with ${target.label}.`)
          }
        >
          {`Continue with ${target.label}`}
          {target.remainingPercent === null
            ? ""
            : ` (${Math.round(target.remainingPercent)}% left)`}
        </Button>
      ))}
      {canSchedule ? (
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => void toggle("resume")}>
          {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
        </Button>
      ) : null}
      {canSchedule && !snoozed ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || Date.parse(resetAt!) <= nowMs}
          onClick={() => void toggle("snooze")}
        >
          {pending ? "Saving..." : "Snooze until reset"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
