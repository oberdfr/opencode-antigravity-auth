/**
 * Whether a pass over the account pool is still making progress.
 *
 * Account selection can hand back an account that the family-level filter calls usable
 * while the header style it would use is rate-limited for it. The answer to that is to
 * switch accounts, and nothing is marked — so when the manager returns the same account
 * again, the loop goes round once more making no request at all. It used to spend the
 * whole iteration budget doing that, and the failure it finally produced described the
 * symptom rather than the cause.
 *
 * Kept separate from the fetch loop because the rule is worth stating on its own: what
 * counts as a stall is "the same account, having given up on it twice", not "the same
 * account twice", because waiting on one account while a request is in flight is
 * legitimate and does happen.
 */

/**
 * @param stalledOn   Account index given up on during the previous pass, if any.
 * @param accountIndex Account index selected now.
 * @param shouldSwitch Whether this pass is giving up on the selected account.
 * @returns true when the same account has now been given up on twice in a row.
 */
export function isSelectionStalled(
  stalledOn: number | undefined,
  accountIndex: number,
  shouldSwitch: boolean,
): boolean {
  if (!shouldSwitch) return false;
  return stalledOn === accountIndex;
}