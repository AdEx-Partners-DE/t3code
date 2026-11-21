import { T, msg, useGT, useMessages } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m, type MessageResolver } from "~/i18n/messages";
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
  resetPassed?: boolean;
  displayPassed?: boolean;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  /** Other accounts that can take this thread over now; see `listLimitSwitchTargets`. */
  switchTargets?: ReadonlyArray<LimitSwitchTarget>;
  onSwitch?: (target: LimitSwitchTarget) => Promise<void>;
};

function parseEpochMs(isoDate: string | null): number | null {
  if (isoDate === null) return null;
  const parsed = Date.parse(isoDate);
  return Number.isFinite(parsed) ? parsed : null;
}

function limitRecoveryScheduleState(
  props: Pick<
    RecoveryProps,
    "runId" | "resetAt" | "stoppedAt" | "settled" | "requestPending" | "recovery" | "snoozedUntil"
  >,
) {
  // The server refuses recovery changes while a request is pending.
  const canSchedule =
    !props.settled &&
    !props.requestPending &&
    props.resetAt !== null &&
    Date.parse(props.resetAt) > Date.parse(props.stoppedAt);
  const resumes =
    canSchedule &&
    props.recovery?.runId === props.runId &&
    props.recovery.resetAt === props.resetAt &&
    props.recovery.autoResume;
  const displayAt =
    resumes &&
    props.resetAt &&
    props.snoozedUntil &&
    Date.parse(props.snoozedUntil) > Date.parse(props.resetAt)
      ? props.snoozedUntil
      : props.resetAt;
  return { canSchedule, resumes, displayAt };
}

export function useUsageLimitRecoveryBannerItem(
  props: RecoveryProps | null,
  resolve: MessageResolver = m,
): ComposerBannerStackItem | null {
  const displayAt = props === null ? null : limitRecoveryScheduleState(props).displayAt;
  const resetPassed = useDeadlinePassed(props === null ? null : parseEpochMs(props.resetAt));
  const displayPassed = useDeadlinePassed(parseEpochMs(displayAt));
  if (props === null) return null;
  return usageLimitRecoveryBannerItem({ ...props, resetPassed, displayPassed }, resolve);
}

export function usageLimitRecoveryBannerItem(
  props: RecoveryProps,
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  const { runId, errorCode, resetAt, timestampFormat } = props;
  const { canSchedule, resumes, displayAt } = limitRecoveryScheduleState(props);
  const resetAtMs = parseEpochMs(resetAt);
  const displayAtMs = parseEpochMs(displayAt);
  const resetPassed = props.resetPassed ?? (resetAtMs !== null && resetAtMs <= Date.now());
  const displayPassed = props.displayPassed ?? (displayAtMs !== null && displayAtMs <= Date.now());
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const recoveryActions =
    canSchedule || (props.switchTargets?.length ?? 0) > 0 ? (
      <RecoveryActions key={`${runId}:${resetAt}`} canSchedule={canSchedule} {...props} />
    ) : null;
  const resumesUpcoming = resumes && !displayPassed;
  const shownAt = resumesUpcoming ? displayAt : resetAt;
  const formattedTime = shownAt
    ? formatUpcomingTimestamp(shownAt, timestampFormat, undefined, undefined, resolve)
    : null;
  const resetDescription =
    formattedTime !== null
      ? resumesUpcoming
        ? resolve(msg("Resumes {time}", { time: formattedTime }))
        : resetPassed
          ? resolve(msg("Reset {time}", { time: formattedTime }))
          : resolve(msg("Resets {time}", { time: formattedTime }))
      : resolve(msg("Reset time unavailable; retry manually"));
  if (!chatGptLimit) {
    return {
      id: `usage-limit-recovery:${runId}`,
      variant: "warning",
      group: "environment",
      icon: <GaugeIcon />,
      title: resolve(msg("Usage limit reached")),
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
    title: resolve(msg("ChatGPT usage limit reached")),
    description: workspaceLimit
      ? resolve(
          msg("You've reached your workspace's limit for using your ChatGPT plan in other apps."),
        )
      : resetDescription,
    actions: (
      <>
        {recoveryActions}
        {workspaceLimit ? (
          <Button size="xs" variant="ghost" onClick={copyAdminRequest}>
            <T>Copy request for admin</T>
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

function switchToLabel(target: LimitSwitchTarget, resolve: MessageResolver): string {
  return target.remainingPercent === null
    ? resolve(msg("Switch to {target}", { target: target.label }))
    : resolve(
        msg("Switch to {target} ({remaining}% left)", {
          target: target.label,
          remaining: Math.round(target.remainingPercent),
        }),
      );
}

function continueWithLabel(target: LimitSwitchTarget, resolve: MessageResolver): string {
  return target.remainingPercent === null
    ? resolve(msg("Continue with {target}", { target: target.label }))
    : resolve(
        msg("Continue with {target} ({remaining}% left)", {
          target: target.label,
          remaining: Math.round(target.remainingPercent),
        }),
      );
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
  resolve: MessageResolver = m,
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
      ? resolve(
          msg("{window} limit used up on {source}", { window: window.label, source: sourceLabel }),
        )
      : resolve(
          msg("{window} limit: {remaining}% left on {source}", {
            window: window.label,
            remaining: Math.round(remainingPercent),
            source: sourceLabel,
          }),
        ),
    description:
      [
        spendingCredits === null
          ? null
          : spendingCredits.balance === null
            ? resolve(msg("Further turns spend credits."))
            : resolve(
                msg("Further turns spend credits ({balance} left).", {
                  balance: formatCreditBalance(spendingCredits.balance),
                }),
              ),
        window.resetsAt
          ? resolve(
              msg("Resets {time}", {
                time: formatUpcomingTimestamp(
                  window.resetsAt,
                  timestampFormat,
                  undefined,
                  undefined,
                  resolve,
                ),
              }),
            )
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
              {switchToLabel(target, resolve)}
            </Button>
          ))}
        </div>
      ),
    dismissLabel: resolve(msg("Dismiss usage limit notice")),
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
  const gt = useGT();
  const messages = useMessages();
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
        description: thrownErrorMessage(cause, m) ?? m(msg("An error occurred.")),
      });
    }
    setPending(false);
  }
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: m(msg("Could not snooze thread")),
        description: m(msg("The reset time has passed. Retry the thread manually.")),
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
      action === "resume"
        ? m(msg("Could not change auto-resume"))
        : m(msg("Could not snooze thread")),
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
            void run(
              async () => onSwitch?.(target),
              m(msg("Could not continue with {target}", { target: target.label })),
            )
          }
        >
          {continueWithLabel(target, messages)}
        </InlineButton>
      ))}
      {canSchedule ? (
        <InlineButton touchTarget="padded" disabled={pending} onClick={() => void toggle("resume")}>
          {pending
            ? gt("Saving...")
            : scheduled
              ? gt("Cancel auto-resume")
              : resetPassed
                ? gt("Resume now")
                : gt("Resume at reset")}
        </InlineButton>
      ) : null}
      {canSchedule ? (
        <InlineButton
          touchTarget="padded"
          disabled={pending || (!snoozed && resetPassed)}
          onClick={() => void toggle("snooze")}
        >
          {pending ? gt("Saving...") : snoozed ? gt("Wake now") : gt("Snooze until reset")}
        </InlineButton>
      ) : null}
    </span>
  );
}
