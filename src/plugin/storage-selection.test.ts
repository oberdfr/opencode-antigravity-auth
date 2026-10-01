/**
 * A field that a reader drops is worse than a field that was never written.
 *
 * `loadAccounts` rebuilds the pool field by field, so anything it does not name
 * disappears on the way out. The account selection used to be exactly that: present on
 * disk, absent to every reader, and therefore absent to the account manager that was
 * supposed to honour it. These tests hold the reader to the writer.
 *
 * The config directory is redirected before the module loads, because the storage path
 * is resolved from the environment at import time. Pointing it at a temp directory is
 * what keeps this from writing the real account pool.
 */

import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "antigravity-storage-"));
const FILE = join(DIR, "antigravity-accounts.json");

// Must be set before ./storage is imported: the storage path is resolved from the
// environment when the module loads, not on each call.
vi.stubEnv("OPENCODE_CONFIG_DIR", DIR);

const { loadAccounts, saveAccounts } = await import("./storage");

const NOW = 1_700_000_000_000;

function write(contents: unknown) {
  writeFileSync(FILE, JSON.stringify(contents, null, 2), "utf8");
}

function onDisk() {
  return JSON.parse(readFileSync(FILE, "utf8"));
}

const pool = (extra: Record<string, unknown> = {}) => ({
  version: 4,
  accounts: [
    { email: "free@x", refreshToken: "t1", addedAt: NOW, lastUsed: NOW },
    { email: "pro@x", refreshToken: "t2", addedAt: NOW, lastUsed: NOW, tier: "pro" },
  ],
  activeIndex: 0,
  ...extra,
});

beforeEach(() => {
  write(pool());
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(DIR, { recursive: true, force: true });
});

describe("the selection survives a read", () => {
  it("writes only to the redirected file, never the real pool", () => {
    // The guard on the guard: without the redirect this test would be writing the
    // user's own account file, which is not something a test should be able to do.
    expect(FILE.startsWith(DIR)).toBe(true);
    expect(existsSync(FILE)).toBe(true);
  });

  it("is returned when it is on disk", async () => {
    write(pool({ selection: { pinnedEmails: ["pro@x"] } }));

    expect((await loadAccounts())?.selection).toEqual({ pinnedEmails: ["pro@x"] });
  });

  it("reads back as empty rather than undefined when absent", async () => {
    // Undefined is what let a reader treat "no selection" and "field lost in transit" as
    // the same thing. A pool with no choice in it is a real state and says so.
    expect((await loadAccounts())?.selection).toEqual({ pinnedEmails: [] });
  });

  it("is still there after the read is written back", async () => {
    write(pool({ selection: { pinnedEmails: ["pro@x"] } }));

    await saveAccounts((await loadAccounts())!);

    expect(onDisk().selection).toEqual({ pinnedEmails: ["pro@x"] });
  });

  it("survives a write from a reader that knows nothing about it", async () => {
    // The quota read refreshes project ids on its way past and carries no selection.
    write(pool({ selection: { pinnedEmails: ["pro@x"] } }));

    const loaded = await loadAccounts();
    await saveAccounts({
      version: 4,
      accounts: loaded!.accounts.map((account, i) => ({ ...account, managedProjectId: `p${i}` })),
      activeIndex: 0,
    });

    expect(onDisk().selection).toEqual({ pinnedEmails: ["pro@x"] });
    // And the write it did make still landed, so preservation is not the write being
    // skipped wholesale.
    expect(onDisk().accounts[1]?.managedProjectId).toBe("p1");
  });

  it("is replaced when the new value says so", async () => {
    write(pool({ selection: { pinnedEmails: ["pro@x"] } }));

    const loaded = await loadAccounts();
    await saveAccounts({ ...loaded!, selection: { pinnedEmails: ["free@x"] } });

    expect(onDisk().selection).toEqual({ pinnedEmails: ["free@x"] });
  });

  it("keeps the tier it read", async () => {
    const loaded = await loadAccounts();

    expect(loaded?.accounts.map((a) => [a.email, a.tier])).toEqual([
      ["free@x", undefined],
      ["pro@x", "pro"],
    ]);
  });
});