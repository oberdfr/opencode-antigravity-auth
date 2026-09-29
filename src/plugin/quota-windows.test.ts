/**
 * A subscription account runs on a five-hour window and a weekly one at the same
 * time, and the two are served from different hosts: the weekly allowance is only
 * answered by the autopush host, and only when asked with the consumer project.
 * Reading one host is why a subscription account used to look like it had a single
 * window, with its weekly allowance simply absent.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { loadAccounts, refreshAccessToken, ensureProjectContext, logQuotaStatus, logQuotaFetch } =
  vi.hoisted(() => ({
    loadAccounts: vi.fn(),
    refreshAccessToken: vi.fn(),
    ensureProjectContext: vi.fn(),
    logQuotaStatus: vi.fn(),
    logQuotaFetch: vi.fn(),
  }));

vi.mock("./storage", () => ({ loadAccounts }));
vi.mock("./token", () => ({ refreshAccessToken }));
vi.mock("./project", () => ({ ensureProjectContext }));
vi.mock("./debug", () => ({ logQuotaStatus, logQuotaFetch }));

import { checkAccountQuotaForTest as checkAccountQuota } from "./quota";

const PROD = "https://cloudcode-pa.googleapis.com";
const AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com";

function bucket(modelId: string, remainingFraction: number, resetTime?: string) {
  return { modelId, remainingFraction, tokenType: "WTUS", ...(resetTime ? { resetTime } : {}) };
}

function body(resetTime: string) {
  return JSON.stringify({
    model: "gemini-3.8-flash-tiered",
    project: "rising-fact-p41fc",
    request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    quotaInfo: { remainingFraction: 1, ...(resetTime ? { resetTime } : {}) },
  });
}

const FIVE_HOUR = new Date(Date.now() + 3 * 3600_000).toISOString();
const WEEKLY = new Date(Date.now() + 6 * 24 * 3600_000).toISOString();
/** A weekly pool that has never been touched, so its window has not started. */
const FULL_WEEK = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

/** Answers the buckets for a host, and 403s for one it does not serve. */
function serveBuckets(byHost: Record<string, ReturnType<typeof bucket>[]>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    const host = url.startsWith(AUTOPUSH) ? AUTOPUSH : PROD;
    const buckets = byHost[host];
    if (!buckets) {
      return new Response(JSON.stringify({ error: { code: 403 } }), { status: 403 });
    }
    return new Response(JSON.stringify({ buckets }), { status: 200 });
  });
}

function account() {
  return { email: "pro@example.com", refreshToken: "token" } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  refreshAccessToken.mockResolvedValue({
    type: "oauth",
    access: "ya29.access",
    expires: Date.now() + 3600_000,
    refresh: "token",
  });
  ensureProjectContext.mockResolvedValue({
    auth: { type: "oauth", access: "ya29.access", expires: Date.now() + 3600_000, refresh: "token" },
    effectiveProjectId: "rising-fact-p41fc",
    consumerProjectId: "aicode-consumers",
    subscription: { id: "g1-pro-tier", name: "Google AI Pro" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading both allowance windows", () => {
  it("reports the five-hour and the weekly window of a subscription account", async () => {
    // The production host carries the five-hour pool and the autopush host the
    // weekly one. Reading only the first is what made the weekly allowance look
    // like it did not exist.
    vi.stubGlobal(
      "fetch",
      serveBuckets({
        [PROD]: [bucket("gemini-3.8-flash-tiered", 0.42, FIVE_HOUR)],
        [AUTOPUSH]: [bucket("gemini-3.8-flash-tiered", 0.99, WEEKLY)],
      }),
    );

    const result = await checkAccountQuota(account(), 0, {} as never, "google-antigravity");

    const windows = result.quota?.groups["gemini-flash"]?.windows ?? [];
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ remainingFraction: 0.42, resetTime: FIVE_HOUR });
    expect(windows[1]).toMatchObject({ remainingFraction: 0.99, resetTime: WEEKLY });
  });

  it("asks the weekly host even when both hosts are given the same project", async () => {
    // The two hosts serve different pools, not the same one under different
    // projects. Skipping the weekly one because the project happens to match is
    // how the weekly allowance went missing on the accounts whose project had
    // already resolved — which is every account once the cache is warm.
    ensureProjectContext.mockResolvedValue({
      auth: { type: "oauth", access: "ya29.access", expires: Date.now() + 3600_000, refresh: "token" },
      effectiveProjectId: "aicode-consumers",
      consumerProjectId: "aicode-consumers",
    });
    const fetchMock = serveBuckets({
      [PROD]: [bucket("gemini-3.8-flash-tiered", 0.42, FIVE_HOUR)],
      [AUTOPUSH]: [bucket("gemini-3.8-flash-tiered", 0.99, WEEKLY)],
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkAccountQuota(account(), 0, {} as never, "google-antigravity");

    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(AUTOPUSH))).toBe(true);
    expect(result.quota?.groups["gemini-flash"]?.windows).toHaveLength(2);
  });

  it("asks the weekly pool for the project the account lookup named", async () => {
    // The autopush host answers the same request with 403 when it is asked with
    // the project requests are made with, so the weekly window is only reachable
    // through the consumer project.
    const fetchMock = serveBuckets({
      [PROD]: [bucket("gemini-3.8-flash-tiered", 0.42, FIVE_HOUR)],
      [AUTOPUSH]: [bucket("gemini-3.8-flash-tiered", 0.99, WEEKLY)],
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkAccountQuota(account(), 0, {} as never, "google-antigravity");

    const autopushCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith(AUTOPUSH));
    expect(autopushCall).toBeDefined();
    expect(JSON.parse(String(autopushCall![1]?.body))).toEqual({
      project: "aicode-consumers",
    });
  });

  it("keeps the five-hour window when the weekly pool does not answer", async () => {
    vi.stubGlobal(
      "fetch",
      serveBuckets({ [PROD]: [bucket("gemini-3.8-flash-tiered", 0.42, FIVE_HOUR)] }),
    );

    const result = await checkAccountQuota(account(), 0, {} as never, "google-antigravity");

    const windows = result.quota?.groups["gemini-flash"]?.windows ?? [];
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ remainingFraction: 0.42, resetTime: FIVE_HOUR });
    expect(result.quota?.error).toBeUndefined();
  });

  it("gives each family its own windows, so Claude and Gemini do not merge", async () => {
    // Claude and Gemini refill separately, and a merged row could only report one
    // of the two families' figures.
    vi.stubGlobal(
      "fetch",
      serveBuckets({
        [PROD]: [
          bucket("claude-sonnet-4-6", 0.1, FIVE_HOUR),
          bucket("gemini-3.8-flash-tiered", 0.9, FIVE_HOUR),
        ],
        [AUTOPUSH]: [
          bucket("claude-sonnet-4-6", 0.8, WEEKLY),
          bucket("gemini-3.8-flash-tiered", 0.95, WEEKLY),
        ],
      }),
    );

    const result = await checkAccountQuota(account(), 0, {} as never, "google-antigravity");

    expect(result.quota?.groups.claude?.windows).toEqual([
      expect.objectContaining({ remainingFraction: 0.1, resetTime: FIVE_HOUR }),
      expect.objectContaining({ remainingFraction: 0.8, resetTime: WEEKLY }),
    ]);
    expect(result.quota?.groups["gemini-flash"]?.windows).toEqual([
      expect.objectContaining({ remainingFraction: 0.9, resetTime: FIVE_HOUR }),
      expect.objectContaining({ remainingFraction: 0.95, resetTime: WEEKLY }),
    ]);
  });

  it("reports one window for a free account, which only has the weekly one", async () => {
    // A free account has no five-hour window: what the production host reports for
    // it is the weekly allowance already, at its own distance from the reset. The
    // untouched pool on the other host is a second weekly that never started
    // counting down, and merging it in would show a third row duplicating it.
    const fetchMock = serveBuckets({
      [PROD]: [bucket("gemini-3.8-flash-tiered", 1, WEEKLY)],
      [AUTOPUSH]: [bucket("gemini-3.8-flash-tiered", 1, FULL_WEEK)],
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkAccountQuota(account(), 0, {} as never, "google-antigravity");

    const windows = result.quota?.groups["gemini-flash"]?.windows ?? [];
    expect(windows).toHaveLength(1);
    expect(windows[0]?.resetTime).toBe(WEEKLY);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(AUTOPUSH))).toBe(false);
  });

  it("does not count the same window reported by both hosts twice", async () => {
    // A subscription account whose five-hour window is untouched still reports a
    // reset for it, and both hosts can name the same window: one reading, one row.
    const shared = new Date(Date.now() + 4 * 3600_000).toISOString();
    vi.stubGlobal(
      "fetch",
      serveBuckets({
        [PROD]: [bucket("gemini-3.8-flash-tiered", 1, shared)],
        [AUTOPUSH]: [bucket("gemini-3.8-flash-tiered", 1, shared)],
      }),
    );

    const result = await checkAccountQuota(account(), 0, {} as never, "google-antigravity");

    expect(result.quota?.groups["gemini-flash"]?.windows).toHaveLength(1);
  });
});
