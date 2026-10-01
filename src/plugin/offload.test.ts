/**
 * Which account a request goes out on, when some of them are blocked.
 *
 * A rate limit is not a preference. The gateway refuses the request, and an account that
 * is refused is not a candidate to be scored against — it is one the request cannot use.
 * The distinction matters because a blocked account that is still handed out does not fail
 * once: it is refused again on the next pass, and again, for as long as whatever judged it
 * available keeps judging it available.
 */

import { describe, expect, it, vi } from "vitest";
import { AccountManager } from "./accounts";

const MODEL = "antigravity-gemini-3.8-flash";
const QUOTA_KEY = `gemini-antigravity:${MODEL}`;

/** An account that has been refused, with the refusal recorded the way a 429 records it. */
function blockedAccount(email: string, index: number) {
  return {
    index,
    email,
    enabled: true,
    refreshToken: `token-${email}`,
    managedProjectId: "project",
    addedAt: 0,
    fingerprint: {
      deviceId: `d-${email}`,
      sessionToken: `s-${email}`,
      userAgent: "antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=1)",
      apiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1",
      clientMetadata: { ideType: "ANTIGRAVITY", platform: "MACOS", pluginType: "GEMINI" },
      createdAt: 0,
    },
    // Five days out, the shape a real quota refusal produces.
    rateLimitResetTimes: { [QUOTA_KEY]: Date.now() + 5 * 24 * 60 * 60 * 1000 },
    lastUsed: 0,
  };
}

function usableAccount(email: string, index: number) {
  return { ...blockedAccount(email, index), rateLimitResetTimes: {} };
}

/** An account blocked for a measured window, so a test can let the window close. */
function shortBlockAccount(email: string, index: number, forMs: number) {
  return { ...blockedAccount(email, index), rateLimitResetTimes: { [QUOTA_KEY]: Date.now() + forMs } };
}

/**
 * A manager over exactly the accounts given.
 *
 * The stored pool is passed in rather than read, so the test describes the situation it is
 * about and nothing else — and cannot pick up whatever the real one happens to hold.
 */
function pool(accounts: unknown[]) {
  return new AccountManager(undefined, {
    accounts,
    activeIndex: 0,
  } as never);
}

describe("an account the requested style is blocked on", () => {
  it("is not handed out while another one can serve", async () => {
    const manager = await pool([blockedAccount("bloccato@gmail.com", 0), usableAccount("sano@gmail.com", 1)]);

    const picked = manager.getCurrentOrNextForFamily("gemini", MODEL, "hybrid", "antigravity");

    expect(picked?.email).toBe("sano@gmail.com");
  });

  it("stays unhanded-out on the next pass, instead of being tried again", async () => {
    // The whole failure was a loop: the refusal was recorded under the key that was never
    // consulted, so the account looked available again immediately and was picked again.
    const manager = await pool([blockedAccount("bloccato@gmail.com", 0), usableAccount("sano@gmail.com", 1)]);

    for (let pass = 0; pass < 5; pass++) {
      const picked = manager.getCurrentOrNextForFamily("gemini", MODEL, "hybrid", "antigravity");
      expect(picked?.email).toBe("sano@gmail.com");
    }
  });

  it("is offered again once the block has passed", () => {
    // Time is moved rather than the state edited: the snapshot is a copy, and the question
    // is whether the same manager comes round to the account on its own once the window
    // the gateway named has closed.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
      const manager = pool([shortBlockAccount("presto-ok@gmail.com", 0, 60_000)]);

      expect(manager.getCurrentOrNextForFamily("gemini", MODEL, "hybrid", "antigravity")).toBeNull();

      vi.setSystemTime(new Date("2026-10-01T12:02:00Z"));

      expect(manager.getCurrentOrNextForFamily("gemini", MODEL, "hybrid", "antigravity")?.email).toBe(
        "presto-ok@gmail.com",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("is judged on the style the request uses, not on the other one", async () => {
    // A block is recorded per style, and an account with no entry for the cli style really
    // can still serve a cli request. What must never happen is the reverse: an account the
    // gateway refuses on the style being sent is not handed out for it.
    const manager = await pool([blockedAccount("bloccato@gmail.com", 0)]);

    const cliStyle = manager.getCurrentOrNextForFamily("gemini", MODEL, "hybrid", "gemini-cli");
    const antigravityStyle = manager.getCurrentOrNextForFamily("gemini", MODEL, "hybrid", "antigravity");

    expect(cliStyle?.email).toBe("bloccato@gmail.com");
    expect(antigravityStyle).toBeNull();
  });
});

describe("when nothing can serve the request", () => {
  it("says so, rather than handing out a refused account", async () => {
    const manager = await pool([blockedAccount("uno@gmail.com", 0), blockedAccount("due@gmail.com", 1)]);

    // The caller falls back to the other style, and tells the user it is waiting. Returning
    // an account that is known to be refused would take that away and produce a 502 instead.
    expect(manager.getCurrentOrNextForFamily("gemini", MODEL, "hybrid", "antigravity")).toBeNull();
  });

  it("does not count an account with no quota entry as usable", async () => {
    // A model that was never requested has no entry. Absence is not availability.
    const manager = await pool([usableAccount("sano@gmail.com", 0)]);

    const picked = manager.getCurrentOrNextForFamily("gemini", MODEL, "hybrid", "antigravity");

    expect(picked?.email).toBe("sano@gmail.com");
  });
});
