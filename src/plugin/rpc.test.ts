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
        claude: { remainingFraction: 0.425, resetTime: "2026-09-27T14:00:00.000Z", modelCount: 2 },
      },
      modelCount: 2,
    },
    geminiCliQuota: {
      models: [{ modelId: "gemini-3-pro-preview", remainingFraction: 0.8 }],
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

  it("maps quota groups and Gemini CLI buckets", async () => {
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
      geminiCli: [{ modelId: "gemini-3-pro-preview", remainingPercent: 80 }],
    });
  });

  it("keeps an account's error text and disabled flag", async () => {
    loadAccounts.mockResolvedValue({ version: 4, accounts: [{ refreshToken: "r" }], activeIndex: 0 });
    checkAccountsQuota.mockResolvedValue([
      okResult({ status: "error", error: "token refresh failed", disabled: true, quota: undefined, geminiCliQuota: undefined }),
    ]);

    const result = await createAntigravityQuotaHandler(client)();

    expect(result.accounts[0]).toMatchObject({
      status: "error",
      error: "token refresh failed",
      enabled: false,
      groups: [],
      geminiCli: [],
    });
  });

  it("clamps remaining fractions into a percentage", async () => {
    loadAccounts.mockResolvedValue({ version: 4, accounts: [{ refreshToken: "r" }], activeIndex: 0 });
    checkAccountsQuota.mockResolvedValue([
      okResult({
        quota: {
          groups: { claude: { remainingFraction: 1.4, modelCount: 1 } },
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
      "google",
    );
  });
});
