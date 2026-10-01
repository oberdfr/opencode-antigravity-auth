/**
 * Which accounts a request may use, and in what order it prefers them.
 *
 * Three separate decisions live here, kept apart because they answer different
 * questions and are made in different places:
 *
 * - *eligibility* is the pin: when the user names accounts, only those are eligible.
 * - *ordering* is the tier: paid accounts before free ones, so a paid allowance is
 *   spent before a free one is touched.
 * - *load balancing* is the existing selection strategy on the account manager, which
 *   picks among whatever this module says is eligible.
 *
 * Deliberately free of account-manager internals: it takes the fields it needs, so
 * the ordering can be reasoned about and tested without a pool, a disk file, or a
 * clock.
 */

/** A paid Google AI plan, or a free one. */
export type AccountTier = "pro" | "free";

/** The parts of an account this module reads. */
export interface SelectableAccount {
  index: number;
  email?: string;
  /**
   * Last known plan tier.
   *
   * Absent means unknown, which is treated as paid rather than free. The asymmetry is
   * deliberate: a paid account whose tier has not been read yet would otherwise be
   * ranked below a free one that had, and the user asked for paid accounts to be
   * consumed first. Guessing "free" here would quietly spend a free allowance while a
   * paid one sat idle; guessing "pro" only risks trying a paid account first.
   */
  tier?: AccountTier;
}

/** The user's account selection, as persisted alongside the account pool. */
export interface AccountSelection {
  /**
   * Emails the user pinned, or empty when every account is eligible.
   *
   * Compared by email because that is what the user identifies an account by. An
   * account whose email is absent can therefore never be pinned, which is the safe
   * direction: it stays eligible under an empty pin and drops out of a specific one.
   */
  pinnedEmails: string[];
}

/** An account with no selection in force. */
export const DEFAULT_SELECTION: AccountSelection = { pinnedEmails: [] };

/** Whether the user has narrowed the pool to specific accounts. */
export function hasPin(selection: AccountSelection | undefined): boolean {
  return Array.isArray(selection?.pinnedEmails) && selection.pinnedEmails.length > 0;
}

/** The tier to rank by, defaulting to paid when it has not been established. */
export function accountTier(account: SelectableAccount): AccountTier {
  return account.tier === "free" ? "free" : "pro";
}

/** Whether this account is inside the pin. An unpinned pool admits everything. */
export function isEligible(account: SelectableAccount, selection?: AccountSelection): boolean {
  if (!hasPin(selection)) return true;
  const email = account.email;
  return typeof email === "string" && selection!.pinnedEmails.includes(email);
}

/** Paid before free, then by position so the order is stable across runs. */
export function compareByTierThenIndex(a: SelectableAccount, b: SelectableAccount): number {
  const byTier = (accountTier(a) === "pro" ? 0 : 1) - (accountTier(b) === "pro" ? 0 : 1);
  return byTier !== 0 ? byTier : a.index - b.index;
}

/**
 * The accounts a request may use, paid tier first.
 *
 * Sorting is what spends the paid allowance first; the filter is what honours the pin.
 */
export function eligibleAccounts<T extends SelectableAccount>(
  accounts: readonly T[],
  selection?: AccountSelection,
): T[] {
  return accounts.filter((account) => isEligible(account, selection)).sort(compareByTierThenIndex);
}

/**
 * Why a pin ran out, phrased for the person who set it.
 *
 * The distinction the message has to carry is between "the accounts you chose are
 * spent" and "every account is spent", because the first is a decision they made and
 * the second is a wall. The caller needs both to decide whether to widen the pin, so
 * this returns the pieces rather than a finished string.
 */
export interface ExhaustionReport {
  /** Accounts the pin named. */
  pinned: number;
  /** Accounts in the pool outside the pin, which is what widening would draw on. */
  fallbackAvailable: number;
}

/**
 * Describes a pin that has nothing left in it.
 *
 * Returns undefined when there was no pin, or when nothing sits outside it: in both
 * cases widening would change nothing, so there is nothing to tell the user about.
 */
export function reportPinExhaustion(
  accounts: readonly SelectableAccount[],
  selection?: AccountSelection,
): ExhaustionReport | undefined {
  if (!hasPin(selection)) return undefined;
  const pinned = accounts.filter((account) => isEligible(account, selection));
  if (pinned.length === 0) return undefined;
  const fallbackAvailable = accounts.filter((account) => !isEligible(account, selection)).length;
  if (fallbackAvailable === 0) return undefined;
  return { pinned: pinned.length, fallbackAvailable };
}

/**
 * The message shown when the pin is spent and the request is about to widen past it.
 *
 * Names the accounts by email so it is clear which ones ran out, and says what
 * happens next rather than leaving the switch to be discovered.
 */
export function pinExhaustedMessage(
  report: ExhaustionReport,
  accounts: readonly SelectableAccount[],
  selection: AccountSelection,
): string {
  const named = accounts
    .filter((account) => isEligible(account, selection))
    .map((account) => account.email)
    .filter((email): email is string => typeof email === "string");
  const list = named.length > 0 ? named.join(", ") : `${report.pinned} selected account(s)`;
  return (
    `Quota finished on your selected account(s): ${list}. ` +
    `Switching to the next available account (paid accounts first).`
  );
}