import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/** Stable per-provider ids let sparse updates merge with full probes. */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/** Spendable account credits, separate from subscription windows and earned resets. */
export const ServerProviderCredits = Schema.Struct({
  hasCredits: Schema.Boolean,
  unlimited: Schema.Boolean,
  /** Decimal credit units as reported by the provider, not a currency amount. */
  balance: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderCredits = typeof ServerProviderCredits.Type;

/**
 * `unavailable` distinguishes an account that can never report windows (API
 * key, Bedrock) from a probe that failed this time, so clients can keep the
 * last good bars for the latter and clear them for the former.
 */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  credits: Schema.optional(Schema.NullOr(ServerProviderCredits)),
  /** Provider-owned usage settings when quota windows are not available to the client. */
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/** Partial updates merge windows by id; omitted windows remain unchanged. */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
  /** Omitted means unchanged; null clears a previously reported balance. */
  credits: Schema.optional(Schema.NullOr(ServerProviderCredits)),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literal("cliproxy"),
  label: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({ instanceId: ProviderInstanceId }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;

const UsagePercent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

/**
 * One recorded reading of an account's quota window. A point exists only where
 * the reading changed, so the line between two points is flat, not unknown.
 */
export const UsageLimitHistoryPoint = Schema.Struct({
  at: IsoDateTime,
  instanceId: ProviderInstanceId,
  driver: Schema.optional(ProviderDriverKind),
  /**
   * The subscription the reading belongs to: the signed-in email, or the
   * credential fingerprint without one. One instance can switch between
   * accounts, so the instance alone does not name a subscription. Absent on
   * readings recorded before accounts were kept.
   */
  account: Schema.optional(TrimmedNonEmptyString),
  /** One email can belong to several workspaces, each with its own quota. */
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  windowId: TrimmedNonEmptyString,
  kind: ServerProviderUsageWindow.fields.kind,
  label: TrimmedNonEmptyString,
  usedPercent: UsagePercent,
  resetsAt: Schema.optional(IsoDateTime),
});
export type UsageLimitHistoryPoint = typeof UsageLimitHistoryPoint.Type;

/**
 * A window that started over between two readings. `ahead` marks a reset
 * that came before the time the provider had announced, as happens when a
 * provider resets every account at once; `unusedPercentBefore` is the
 * allowance that was still there and went unused.
 */
export const UsageLimitReset = Schema.Struct({
  /** The first reading after the reset, which is when it was registered. */
  at: IsoDateTime,
  instanceId: ProviderInstanceId,
  driver: Schema.optional(ProviderDriverKind),
  account: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  windowId: TrimmedNonEmptyString,
  kind: ServerProviderUsageWindow.fields.kind,
  label: TrimmedNonEmptyString,
  usedPercentBefore: UsagePercent,
  unusedPercentBefore: UsagePercent,
  usedPercentAfter: UsagePercent,
  /** The last reading before the drop; the reset happened between this and `at`. */
  lastSeenBeforeAt: IsoDateTime,
  expectedAt: Schema.optional(IsoDateTime),
  ahead: Schema.Boolean,
});
export type UsageLimitReset = typeof UsageLimitReset.Type;

export const UsageLimitHistoryInput = Schema.Struct({
  /** Oldest instant to return. */
  since: IsoDateTime,
});
export type UsageLimitHistoryInput = typeof UsageLimitHistoryInput.Type;

/** Recorded readings and resets of every account, oldest first. */
export const UsageLimitHistory = Schema.Struct({
  points: Schema.Array(UsageLimitHistoryPoint),
  resets: Schema.Array(UsageLimitReset),
});
export type UsageLimitHistory = typeof UsageLimitHistory.Type;
