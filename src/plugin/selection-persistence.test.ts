/**
 * The account selection has to survive the writes that happen around it.
 *
 * The pool is written from several places — the account manager on a timer, the quota
 * read refreshing project ids, the menu — and most of them are not selection-aware.
 * These tests pin the behaviour that matters: the manager that owns the selection is
 * also the one that saves it, a reload reads it back, and the tiers learned from quota
 * readings are not erased by the next save.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

/** Captures what the manager hands to the storage layer. */
const written: AccountStorageV4[] = [];
let stored: AccountStorageV4 | null = null;

vi.mock("./storage", async () => {
  const actual = await vi.importActual<typeof import("./storage")>("./storage");
  return {
    ...actual,
    loadAccounts: vi.fn(async () => stored),
    saveAccounts: vi.fn(async (next: AccountStorageV4) => {
      written.push(structuredClone(next));
      stored = next;
    }),
  };
});

const { AccountManager } = await import("./accounts");
type AccountStorageV4 = import("./storage").AccountStorageV4;
type AccountMetadataV3 = import("./storage").AccountMetadataV3;

const NOW = 1_700_000_000_000;

function account(email: string, extra: Partial<AccountMetadataV3> = {}): AccountMetadataV3 {
  return {
    email,
    refreshToken: `token-${email}`,
    addedAt: NOW,
    lastUsed: NOW,
    ...extra,
  };
}

/** free, then two paid, so a tier mix is present and position is not tier order. */
function pool(extra: Partial<AccountStorageV4> = {}): AccountStorageV4 {
  return {
    version: 4,
    accounts: [
      account("free-one@gmail.com", { tier: "free" }),
      account("pro-one@gmail.com", { tier: "pro" }),
      account("pro-two@gmail.com", { tier: "pro" }),
    ],
    activeIndex: 0,
    ...extra,
  };
}

beforeEach(() => {
  written.length = 0;
  stored = null;
});

describe("the selection the manager owns", () => {
  it("is read back from the stored pool", () => {
    const manager = new AccountManager(
      undefined,
      pool({ selection: { pinnedEmails: ["pro-two@gmail.com", "pro-one@gmail.com"] } }),
    );

    expect(manager.hasSelection()).toBe(true);
    expect(manager.getSelection().pinnedEmails).toEqual([
      "pro-two@gmail.com",
      "pro-one@gmail.com",
    ]);
  });

  it("orders the chosen accounts paid first, then by position", () => {
    const manager = new AccountManager(
      undefined,
      pool({ selection: { pinnedEmails: ["pro-two@gmail.com", "free-one@gmail.com"] } }),
    );

    // The pin is written in whatever order the user clicked, and what comes back is the
    // order requests will use: paid ahead of free, and stable within a tier.
    expect(manager.getSelectableAccounts().map((a) => a.email)).toEqual([
      "pro-two@gmail.com",
      "free-one@gmail.com",
    ]);
  });

  it("is saved with the pool, so it cannot be dropped by a save it had no part in", async () => {
    const manager = new AccountManager(
      undefined,
      pool({ selection: { pinnedEmails: ["pro-one@gmail.com"] } }),
    );

    await manager.saveToDisk();

    expect(written.at(-1)?.selection).toEqual({ pinnedEmails: ["pro-one@gmail.com"] });
  });

  it("keeps the tiers learned from a quota reading", async () => {
    const manager = new AccountManager(undefined, pool());

    await manager.saveToDisk();

    const saved = written.at(-1)!;
    expect(saved.accounts.map((a) => [a.email, a.tier])).toEqual([
      ["free-one@gmail.com", "free"],
      ["pro-one@gmail.com", "pro"],
      ["pro-two@gmail.com", "pro"],
    ]);
  });

  it("keeps the stored selection when the manager reloaded and saved", async () => {
    stored = pool({ selection: { pinnedEmails: ["pro-two@gmail.com"] } });
    const manager = await AccountManager.loadFromDisk();

    expect(manager.hasSelection()).toBe(true);
    await manager.saveToDisk();
    expect(written.at(-1)?.selection).toEqual({ pinnedEmails: ["pro-two@gmail.com"] });
  });
});

describe("narrowing and widening the pool", () => {
  it("drops an email that is not in the pool rather than storing a hole", async () => {
    const manager = new AccountManager(undefined, pool());

    const result = await manager.setSelection(["pro-one@gmail.com", "ghost@gmail.com"]);

    expect(result.pinnedEmails).toEqual(["pro-one@gmail.com"]);
    expect(written.at(-1)?.selection).toEqual({ pinnedEmails: ["pro-one@gmail.com"] });
  });

  it("widens back to the whole pool on an empty list", async () => {
    const manager = new AccountManager(
      undefined,
      pool({ selection: { pinnedEmails: ["pro-one@gmail.com"] } }),
    );

    await manager.setSelection([]);

    expect(manager.hasSelection()).toBe(false);
    expect(manager.getSelectableAccounts()).toHaveLength(3);
  });

  it("widens back when the pin has nothing usable left and accounts remain outside it", async () => {
    const manager = new AccountManager(
      undefined,
      pool({ selection: { pinnedEmails: ["pro-one@gmail.com"] } }),
    );

    // A pin naming one account, with two others in the pool, is exactly the situation
    // the notification is for.
    const exhaustion = manager.describeSelectionExhaustion();
    expect(exhaustion).toEqual({ pinned: 1, fallbackAvailable: 2 });

    await manager.clearSelection();
    expect(manager.hasSelection()).toBe(false);
  });

  it("reports no exhaustion when the pin already covers everything", () => {
    const manager = new AccountManager(
      undefined,
      pool({ selection: { pinnedEmails: ["free-one@gmail.com", "pro-one@gmail.com", "pro-two@gmail.com"] } }),
    );

    expect(manager.describeSelectionExhaustion()).toBeUndefined();
  });

  it("starts a fresh selection in tier order after the pool is narrowed", async () => {
    const manager = new AccountManager(undefined, pool());

    await manager.setSelection(["pro-two@gmail.com"]);

    // Only the pinned account is eligible, so the first request after the change lands
    // on it rather than on whatever the previous ordering pointed at.
    expect(manager.getSelectableAccounts().map((a) => a.email)).toEqual(["pro-two@gmail.com"]);
  });
});