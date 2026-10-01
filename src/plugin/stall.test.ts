/**
 * A request that spins without ever being made.
 *
 * Account selection can return an account the family-level filter considers usable while
 * the header style it would use is rate-limited for it. The response is to switch
 * accounts and nothing is marked, so when the manager hands back the same account the
 * loop goes round again making no request at all. It used to burn the whole iteration
 * budget that way — fifty passes per request, twelve requests — and the failure it
 * eventually produced described the symptom rather than the cause.
 *
 * These cover the rule that decides a pass has stopped making progress. It is about
 * giving up on the same account twice, not about seeing it twice: waiting on one account
 * while a request is in flight is legitimate.
 */

import { describe, expect, it } from "vitest";
import { isSelectionStalled } from "./stall";

describe("recognising a selection that is not making progress", () => {
  it("lets the first switch through", () => {
    expect(isSelectionStalled(undefined, 2, true)).toBe(false);
  });

  it("stops when the same account comes back", () => {
    // The first pass gave up on account 2; being handed it again is the stall.
    expect(isSelectionStalled(2, 2, true)).toBe(true);
  });

  it("allows a different account, because that is progress", () => {
    expect(isSelectionStalled(2, 3, true)).toBe(false);
  });

  it("does not count a pass that is making a request", () => {
    expect(isSelectionStalled(2, 2, false)).toBe(false);
  });

  it("gives up on the second selection rather than the fiftieth", () => {
    // What the loop does once the rule is in place: the first pass gives up on the
    // account, and being handed it again ends the request there.
    let stalledOn: number | undefined;
    let selections = 0;

    while (selections < 50) {
      if (isSelectionStalled(stalledOn, 1, true)) break;
      selections++;
      stalledOn = 1;
    }

    // One selection completed, then the repeat was caught on the way to the second.
    expect(selections).toBe(1);
  });

  it("would not have caught this by counting distinct accounts", () => {
    // The loop kept re-selecting a single account, so a count of distinct accounts
    // never grew past one and the budget was spent regardless. The rule has to key on
    // the repeat, not on how many different accounts were seen.
    const seen = new Set<number>();
    let stalledOn: number | undefined;
    let passes = 0;
    let stalled = false;

    while (passes < 50 && !stalled) {
      seen.add(1);
      stalled = isSelectionStalled(stalledOn, 1, true);
      stalledOn = 1;
      passes++;
    }

    expect(seen.size).toBe(1);
    expect(passes).toBe(2);
  });
});