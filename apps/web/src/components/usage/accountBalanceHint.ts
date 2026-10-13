/**
 * Whether the account a standing model override sends work to runs out of its week before the
 * reset while another account of the same provider would leave allowance unused. The automatic
 * switch at the limit only acts at 100%; this lets the cockpit suggest moving the work earlier.
 *
 * @module accountBalanceHint
 */
import type { UsageLimitTrendAccount } from "./usageLimitTrend";

export interface AccountBalanceHint {
  readonly from: {
    readonly instanceId: string;
    readonly name: string;
    /** When the week runs out at the current pace. */
    readonly emptyAt: string;
    readonly resetsAt: string;
  };
  readonly to: {
    readonly instanceId: string;
    readonly name: string;
    /** Allowance the week would leave unused at its reset at the current pace. */
    readonly unusedPercent: number;
  };
}

/** Below this, moving work is not worth a hint. */
const MIN_UNUSED_PERCENT = 20;

export function accountBalanceHint(input: {
  readonly accounts: ReadonlyArray<UsageLimitTrendAccount>;
  /** Accounts a standing override currently sends work to. */
  readonly overrideInstanceIds: ReadonlyArray<string>;
  /** The provider driver of an account, so only like accounts are compared. */
  readonly driverOf: (instanceId: string) => string | undefined;
}): AccountBalanceHint | null {
  const weekly = (account: UsageLimitTrendAccount) =>
    account.lines.find((line) => line.kind === "weekly")?.forecast;
  for (const instanceId of input.overrideInstanceIds) {
    const source = input.accounts.find((account) => account.instanceId === instanceId);
    const forecast = source === undefined ? undefined : weekly(source);
    if (source === undefined || forecast?.type !== "runs-out") continue;
    const driver = input.driverOf(instanceId);
    if (driver === undefined) continue;
    let best: AccountBalanceHint["to"] | null = null;
    for (const account of input.accounts) {
      if (account.instanceId === instanceId || input.driverOf(account.instanceId) !== driver) {
        continue;
      }
      const other = weekly(account);
      if (other?.type !== "lasts" || other.unusedPercent < MIN_UNUSED_PERCENT) continue;
      if (best === null || other.unusedPercent > best.unusedPercent) {
        best = {
          instanceId: account.instanceId,
          name: account.name,
          unusedPercent: other.unusedPercent,
        };
      }
    }
    if (best !== null) {
      return {
        from: {
          instanceId,
          name: source.name,
          emptyAt: forecast.at,
          resetsAt: forecast.resetsAt,
        },
        to: best,
      };
    }
  }
  return null;
}
