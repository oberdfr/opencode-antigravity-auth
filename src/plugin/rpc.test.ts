import { describe, expect, it, vi, beforeEach } from "vitest";

const { checkAccountsQuota, loadAccounts } = vi.hoisted(() => ({
  checkAccountsQuota: vi.fn(),
  loadAccounts: vi.fn(),
}));

vi.mock("./quota", () => ({ checkAccountsQuota }));
vi.mock("./storage", () => ({ loadAccounts }));

import { createAntigravityQuotaHandler } from "./rpc";
import type { PluginClient } from "./types";

const client = {} as PluginClient;

function okResult(overrides: Record<string, unknown> = {}) {
  return {
    index: 0,
    email: "work@example.com",
    status: "ok",
    quota: {
      groups: {
        claude: {
          windows: [
            { remainingFraction: 0.425, resetTime: "2026-09-27T14:00:00.000Z", modelCount: 2 },
          ],
          modelCount: 2,
        },
      },
      modelCount: 2,
    },
    ...overrides,
  };
}

describe("antigravity.quota RPC handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a friendly note instead of failing when no accounts exist", async () => {
    loadAccounts.mockResolvedValue(null);

    const result = await createAntigravityQuotaHandler(client)();

    expect(result.available).toBe(false);
    expect(result.accounts).toEqual([]);
    expect(result.reason).toMatch(/No Antigravity accounts/);
    expect(checkAccountsQuota).not.toHaveBeenCalled();
  });

  it("maps quota groups, one row per window", async () => {
    loadAccounts.mockResolvedValue({ version: 4, accounts: [{ refreshToken: "r" }], activeIndex: 0 });
    checkAccountsQuota.mockResolvedValue([okResult()]);

    const result = await createAntigravityQuotaHandler(client)();

    expect(result.available).toBe(true);
    expect(result.accounts[0]).toEqual({
      index: 0,
      email: "work@example.com",
      status: "ok",
      enabled: true,
      groups: [
        {
          id: "claude",
          label: "Claude",
          remainingPercent: 42.5,
          resetTime: "2026-09-27T14:00:00.000Z",
          modelCount: 2,
        },
      ],
    });
  });

  it("reports a family that runs on two windows as two rows", async () => {
    // A subscription account has a five-hour window and a weekly one at the same
    // time. Collapsing them into one row can only report one of the two, which is
    // how a weekly allowance went missing from a subscription account entirely.
    loadAccounts.mockResolvedValue({ version: 4, accounts: [{ refreshToken: "r" }], activeIndex: 0 });
    checkAccountsQuota.mockResolvedValue([
      okResult({
        quota: {
          groups: {
            "gemini-pro": {
              windows: [
                { remainingFraction: 0.99, resetTime: "2026-09-29T18:00:00.000Z", modelCount: 12 },
                { remainingFraction: 0.8, resetTime: "2026-10-05T12:00:00.000Z", modelCount: 12 },
              ],
              modelCount: 24,
            },
          },
          modelCount: 24,
        },
      }),
    ]);

    const result = await createAntigravityQuotaHandler(client)();

    expect(result.accounts[0]?.groups).toEqual([
      {
        id: "gemini-pro",
        label: "Gemini Pro",
        remainingPercent: 99,
        resetTime: "2026-09-29T18:00:00.000Z",
        modelCount: 12,
      },
      {
        id: "gemini-pro",
        label: "Gemini Pro",
        remainingPercent: 80,
        resetTime: "2026-10-05T12:00:00.000Z",
        modelCount: 12,
        // How long each window still has to run, so the consumer can tell the
        // five-hour one from the weekly one without measuring the reset itself.
        windowMinutes: expect.any(Number),
      },
    ]);
  });

  it("keeps an account's error text and disabled flag", async () => {
    loadAccounts.mockResolvedValue({ version: 4, accounts: [{ refreshToken: "r" }], activeIndex: 0 });
    checkAccountsQuota.mockResolvedValue([
      okResult({ status: "error", error: "token refresh failed", disabled: true, quota: undefined }),
    ]);

    const result = await createAntigravityQuotaHandler(client)();

    expect(result.accounts[0]).toMatchObject({
      status: "error",
      error: "token refresh failed",
      enabled: false,
      groups: [],
    });
  });

  it("clamps remaining fractions into a percentage", async () => {
    loadAccounts.mockResolvedValue({ version: 4, accounts: [{ refreshToken: "r" }], activeIndex: 0 });
    checkAccountsQuota.mockResolvedValue([
      okResult({
        quota: {
          groups: { claude: { windows: [{ remainingFraction: 1.4, modelCount: 1 }], modelCount: 1 } },
          modelCount: 1,
        },
      }),
    ]);

    const result = await createAntigravityQuotaHandler(client)();
    expect(result.accounts[0]?.groups[0]?.remainingPercent).toBe(100);
  });

  it("passes the plugin client and provider id through to the quota engine", async () => {
    loadAccounts.mockResolvedValue({ version: 4, accounts: [{ refreshToken: "r" }], activeIndex: 0 });
    checkAccountsQuota.mockResolvedValue([okResult()]);

    await createAntigravityQuotaHandler(client)();

    expect(checkAccountsQuota).toHaveBeenCalledWith(
      [{ refreshToken: "r" }],
      client,
      "google-antigravity",
    );
  });
});
