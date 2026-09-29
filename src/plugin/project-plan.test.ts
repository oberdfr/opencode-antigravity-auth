/**
 * The project lookup is what answers "which plan is this account on".
 *
 * Two things had to be exactly right for that answer to come back, and both
 * failed quietly rather than loudly: Google answers 400 when the request
 * carries the richer metadata, and it answers 200 with a body that simply has
 * no tier in it when the User-Agent is the Google API client's. Either way the
 * account fell back to the default project and looked like it had no plan.
 *
 * These pin the request shape, since neither failure gives an error to notice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./storage", () => ({ getConfigDir: () => configDir }));

let configDir = "";

const ACCESS = "access-token";

/** The tier-bearing body Google returns for the Antigravity User-Agent. */
function payloadWithTier(paidTierId: string, name: string) {
  return {
    currentTier: { id: "free-tier" },
    paidTier: { id: paidTierId, name },
    cloudaicompanionProject: "aicode-consumers",
    allowedTiers: [
      { id: "free-tier", isDefault: true },
      { id: "standard-tier" },
    ],
  };
}

async function loadProject() {
  vi.resetModules();
  return await import("./project");
}

describe("loadManagedProject request shape", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "opencode-tier-"));
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => payloadWithTier("g1-pro-tier", "Google AI Pro"),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(configDir, { recursive: true, force: true });
  });

  it("sends only ideType, because the richer metadata is rejected", async () => {
    const { loadManagedProject } = await loadProject();
    await loadManagedProject(ACCESS, "rising-fact-p41fc");

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as { metadata: Record<string, string> };
    // platform and pluginType here make Google answer 400.
    expect(body.metadata).toEqual({ ideType: "ANTIGRAVITY" });
  });

  it("asks as Antigravity, because the Google API client gets a body with no tier", async () => {
    const { getAntigravityHeaders } = await import("../constants");
    const { loadManagedProject } = await loadProject();
    await loadManagedProject(ACCESS, "rising-fact-p41fc");

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    // The Google API client's User-Agent is answered with a 200 whose body has
    // no tier in it, which is why this cannot be loosened.
    expect(headers["User-Agent"]).not.toBe("google-api-nodejs-client/9.15.1");
    expect(headers["User-Agent"]).toBe(getAntigravityHeaders()["User-Agent"]);
  });

  it("reads the paid tier, which is what says whether the account is a subscription", async () => {
    const { loadManagedProject } = await loadProject();

    const payload = await loadManagedProject(ACCESS, "rising-fact-p41fc");

    // currentTier alone is "free-tier" even for a paid account, so the two have
    // to be read separately or every account looks like the free one.
    expect(payload?.currentTier?.id).toBe("free-tier");
    expect(payload?.paidTier?.id).toBe("g1-pro-tier");
    expect(payload?.paidTier?.name).toBe("Google AI Pro");
  });
});

describe("the plan on a resolved context", () => {
  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "opencode-tier-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("loadCodeAssist")) {
          return { ok: true, json: async () => payloadWithTier("g1-pro-tier", "Google AI Pro") };
        }
        return { ok: false, status: 404, text: async () => "" };
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(configDir, { recursive: true, force: true });
  });

  it("is attached to the context, including on the fallback path", async () => {
    const { ensureProjectContext } = await loadProject();

    // No managed project in the payload's siblings here, and onboarding is not
    // answered, so this resolves through a fallback. The plan does not depend on
    // how the project resolved, so it has to survive either way.
    const result = await ensureProjectContext({ type: "oauth", access: ACCESS, refresh: "1//token" });

    expect(result.subscription).toEqual({ id: "g1-pro-tier", name: "Google AI Pro" });
  });

  it("is absent when the lookup reports no tier", async () => {
    const { loadManagedProject } = await loadProject();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ cloudaicompanionProject: "aicode-consumers" }) })),
    );

    const payload = await loadManagedProject(ACCESS, "rising-fact-p41fc");

    expect(payload?.paidTier).toBeUndefined();
  });
});
