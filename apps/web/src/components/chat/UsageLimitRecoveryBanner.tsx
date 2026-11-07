import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import type {
  LimitSwitchSuggestion,
  LimitSwitchTarget,
} from "@t3tools/client-runtime/state/limit-switch-targets";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import { limitRecoveryOwnsSnooze } from "@t3tools/client-runtime/state/thread-execution";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { Button, InlineButton } from "../ui/button";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { copyAdminRequest } from "./ThreadErrorBanner";

type RecoveryProps = {
  runId: RunId;
  errorCode: string | null;
  resetAt: string | null;
  stoppedAt: string;
  settled: boolean;
  requestPending: boolean;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  timestampFormat: TimestampFormat;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  /** Other accounts that can take this thread over now; see `listLimitSwitchTargets`. */
  switchTargets?: ReadonlyArray<LimitSwitchTarget>;
  onSwitch?: (target: LimitSwitchTarget) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const {
    runId,
    errorCode,
    resetAt,
    stoppedAt,
    settled,
    requestPending,
    recovery,
    snoozedUntil,
    timestampFormat,
  } = props;
  // The server refuses recovery changes while a request is pending.
  const canSchedule =
    !settled && !requestPending && resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const resumes =
    canSchedule && recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const recoveryActions =
    canSchedule || (props.switchTargets?.length ?? 0) > 0 ? (
      <RecoveryActions key={`${runId}:${resetAt}`} canSchedule={canSchedule} {...props} />
    ) : null;
  const displayAt =
    resumes && resetAt && snoozedUntil && Date.parse(snoozedUntil) > Date.parse(resetAt)
      ? snoozedUntil
      : resetAt;
  const resetDescription = displayAt
    ? `${resumes ? "Resumes" : "Resets"} ${formatUpcomingTimestamp(displayAt, timestampFormat)}`
    : "Reset time unavailable; retry manually";
  if (!chatGptLimit) {
    return {
      id: `usage-limit-recovery:${runId}`,
      variant: "warning",
      group: "environment",
      icon: <GaugeIcon />,
      title: "Usage limit reached",
      description: resetDescription,
      actions: recoveryActions,
    };
  }
  // OpenAI's partner guidelines specify this ChatGPT notice and its actions.
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    group: "environment",
    icon: <OpenAI aria-hidden="true" />,
    title: "ChatGPT usage limit reached",
    description: workspaceLimit
      ? "You've reached your workspace's limit for using your ChatGPT plan in other apps."
      : resetDescription,
    actions: (
      <>
        {recoveryActions}
        {workspaceLimit ? (
          <Button size="xs" variant="ghost" onClick={copyAdminRequest}>
            Copy request for admin
          </Button>
        ) : (
          <ChatGptUsageButton size="xs" variant="ghost" />
        )}
      </>
    ),
  };
}

/** The provider reports a decimal string; whole credits are all the notice needs. */
function formatCreditBalance(balance: string): string {
  const value = Number(balance);
  return Number.isFinite(value) ? Math.floor(value).toLocaleString() : balance;
}

function switchTargetLabel(verb: string, target: LimitSwitchTarget): string {
  const left =
    target.remainingPercent === null ? "" : ` (${Math.round(target.remainingPercent)}% left)`;
  return `${verb} ${target.label}${left}`;
}

/**
 * Shown before any turn fails: the selected account is low on, or out of, a
 * window, and a provider that keeps going past its allowance would never say so.
 */
export function limitSwitchBannerItem(
  suggestion: LimitSwitchSuggestion,
  onSwitch: (target: LimitSwitchTarget) => void,
  onDismiss: (id: string) => void,
  timestampFormat: TimestampFormat,
): ComposerBannerStackItem {
  const { window, sourceLabel, targets, remainingPercent, spendingCredits } = suggestion;
  const usedUp = remainingPercent <= 0;
  // The level is part of the id, so dismissing the heads-up does not hide "used up".
  const id = `usage-window:${usedUp ? "used-up" : "low"}:${sourceLabel}:${window.id}:${window.resetsAt ?? ""}`;
  return {
    id,
    variant: usedUp ? "warning" : "info",
    group: "environment",
    icon: <GaugeIcon />,
    title: usedUp
      ? `${window.label} limit used up on ${sourceLabel}`
      : `${window.label} limit: ${Math.round(remainingPercent)}% left on ${sourceLabel}`,
    description:
      [
        spendingCredits === null
          ? null
          : spendingCredits.balance === null
            ? "Further turns spend credits."
            : `Further turns spend credits (${formatCreditBalance(spendingCredits.balance)} left).`,
        window.resetsAt
          ? `Resets ${formatUpcomingTimestamp(window.resetsAt, timestampFormat)}`
          : null,
      ]
        .filter((part) => part !== null)
        .join(" ") || undefined,
    actions:
      targets.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {targets.map((target) => (
            <Button
              key={target.selection.instanceId}
              size="xs"
              variant="ghost"
              onClick={() => onSwitch(target)}
            >
              {switchTargetLabel("Switch to", target)}
            </Button>
          ))}
        </div>
      ),
    dismissLabel: "Dismiss usage limit notice",
    onDismiss: () => onDismiss(id),
  };
}

function RecoveryActions({
  runId,
  resetAt,
  recovery,
  snoozedUntil,
  onChange,
  switchTargets = [],
  onSwitch,
  canSchedule,
}: RecoveryProps & { canSchedule: boolean }) {
  const [pending, setPending] = useState(false);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  // The server leaves snoozedUntil in place after the timer wakes the thread,
  // so a snooze whose reset has passed is no longer active.
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const snoozed =
    limitRecoveryOwnsSnooze({ runId, resetAt, recovery, snoozedUntil }) && !resetPassed;
  async function run(change: () => Promise<void>, title: string) {
    setPending(true);
    try {
      await change();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title,
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(false);
  }
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: "Could not snooze thread",
        description: "The reset time has passed. Retry the thread manually.",
      });
      // The deadline timer can lag after a throttled tab or sleep; disable now.
      deadlineStore(Date.parse(resetAt)).refresh();
      return;
    }
    await run(
      () =>
        onChange({
          runId,
          resetAt,
          ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
        }),
      action === "resume" ? "Could not change auto-resume" : "Could not snooze thread",
    );
  }
  // Inline errors would widen the actions column and crush the title.
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      {switchTargets.map((target) => (
        <InlineButton
          key={target.selection.instanceId}
          touchTarget="padded"
          disabled={pending || !onSwitch}
          onClick={() =>
            void run(async () => onSwitch?.(target), `Could not continue with ${target.label}`)
          }
        >
          {switchTargetLabel("Continue with", target)}
        </InlineButton>
      ))}
      {canSchedule ? (
        <InlineButton touchTarget="padded" disabled={pending} onClick={() => void toggle("resume")}>
          {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
        </InlineButton>
      ) : null}
      {canSchedule ? (
        <InlineButton
          touchTarget="padded"
          disabled={pending || (!snoozed && resetPassed)}
          onClick={() => void toggle("snooze")}
        >
          {pending ? "Saving..." : snoozed ? "Wake now" : "Snooze until reset"}
        </InlineButton>
      ) : null}
    </span>
  );
}
