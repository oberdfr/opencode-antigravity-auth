/**
 * Which account a request uses, and what happens when the chosen ones run out.
 *
 * The three rules under test are the ones the user asked for: choose the accounts,
 * balance across them, and when their quota is gone say so and move on paid-first.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELECTION,
  accountTier,
  compareByTierThenIndex,
  eligibleAccounts,
  hasPin,
  isEligible,
  pinExhaustedMessage,
  reportPinExhaustion,
  type AccountSelection,
  type SelectableAccount,
} from "./selection";

const account = (
  email: string,
  tier?: "pro" | "free",
  index = 0,
): SelectableAccount => ({ email, ...(tier ? { tier } : {}), index });

/** Four accounts: two paid, two free, interleaved so position cannot stand in for tier. */
const pool: SelectableAccount[] = [
  account("free-one@gmail.com", "free", 0),
  account("pro-one@gmail.com", "pro", 1),
  account("free-two@gmail.com", "free", 2),
  account("pro-two@gmail.com", "pro", 3),
];

const selection = (...pinnedEmails: string[]): AccountSelection => ({
  pinnedEmails: [...pinnedEmails],
});

describe("which accounts are eligible", () => {
  it("admits the whole pool when nothing is chosen", () => {
    expect(hasPin(DEFAULT_SELECTION)).toBe(false);
    expect(eligibleAccounts(pool, DEFAULT_SELECTION)).toHaveLength(4);
  });

  it("admits only the chosen accounts when something is", () => {
    const chosen = selection("pro-two@gmail.com", "free-one@gmail.com");

    expect(hasPin(chosen)).toBe(true);
    expect(eligibleAccounts(pool, chosen).map((a) => a.email)).toEqual([
      "pro-two@gmail.com",
      "free-one@gmail.com",
    ]);
  });

  it("excludes an account the user did not name", () => {
    const chosen = selection("pro-one@gmail.com");

    expect(isEligible(account("pro-two@gmail.com"), chosen)).toBe(false);
    expect(isEligible(account("pro-one@gmail.com"), chosen)).toBe(true);
  });

  it("cannot pin an account that has no email", () => {
    // There is nothing to match an email against, so it stays out of a specific
    // selection rather than silently claiming a slot in it.
    const anonymous: SelectableAccount = { index: 0 };

    expect(isEligible(anonymous, selection("pro-one@gmail.com"))).toBe(false);
    expect(isEligible(anonymous, DEFAULT_SELECTION)).toBe(true);
  });
});

describe("spending paid allowances first", () => {
  it("puts paid accounts ahead of free ones whatever their position", () => {
    expect(eligibleAccounts(pool, DEFAULT_SELECTION).map((a) => a.email)).toEqual([
      "pro-one@gmail.com",
      "pro-two@gmail.com",
      "free-one@gmail.com",
      "free-two@gmail.com",
    ]);
  });

  it("keeps a stable order within a tier", () => {
    const sameTier = [account("c@x", "free", 5), account("a@x", "free", 2), account("b@x", "free", 9)];

    expect(eligibleAccounts(sameTier, DEFAULT_SELECTION).map((a) => a.email)).toEqual([
      "a@x",
      "c@x",
      "b@x",
    ]);
  });

  it("treats an account whose tier is unknown as paid", () => {
    // Reading a paid account as free would spend a free allowance while the paid one
    // sat idle, which is the opposite of what was asked for. Guessing paid only risks
    // trying a paid account first.
    expect(accountTier(account("unknown@x"))).toBe("pro");
    expect(eligibleAccounts([account("unknown@x", undefined, 9), account("f@x", "free", 0)], DEFAULT_SELECTION)[0]?.email).toBe(
      "unknown@x",
    );
  });

  it("compares paid before free and position within", () => {
    const a = account("a@x", "free", 0);
    const b = account("b@x", "pro", 9);

    expect(compareByTierThenIndex(a, b)).toBeGreaterThan(0);
    expect(compareByTierThenIndex(b, a)).toBeLessThan(0);
  });
});

describe("running out of the chosen accounts", () => {
  it("reports the exhaustion and what is left to fall back on", () => {
    const report = reportPinExhaustion(pool, selection("pro-one@gmail.com"));

    expect(report).toEqual({ pinned: 1, fallbackAvailable: 3 });
  });

  it("says nothing when there is no pin, since widening would change nothing", () => {
    expect(reportPinExhaustion(pool, DEFAULT_SELECTION)).toBeUndefined();
  });

  it("says nothing when the pin already covers the whole pool", () => {
    const all = selection(...pool.map((a) => a.email!));

    expect(reportPinExhaustion(pool, all)).toBeUndefined();
  });

  it("names the accounts that ran out and says what happens next", () => {
    const chosen = selection("pro-one@gmail.com", "pro-two@gmail.com");
    const report = reportPinExhaustion(pool, chosen)!;

    const message = pinExhaustedMessage(report, pool, chosen);

    // The user chose these, so the message has to be specific enough to act on.
    expect(message).toContain("pro-one@gmail.com");
    expect(message).toContain("pro-two@gmail.com");
    expect(message).toMatch(/quota finished/i);
    expect(message).toMatch(/paid accounts first/i);
  });

  it("falls back to a count when a pinned account has no email to name", () => {
    const anonymous: SelectableAccount = { index: 0, tier: "pro" };
    const withAnonymous = [...pool, anonymous];
    const chosen = selection("pro-one@gmail.com");
    const report = reportPinExhaustion(withAnonymous, chosen)!;

    expect(pinExhaustedMessage(report, withAnonymous, chosen)).toContain("selected account(s)");
  });
});