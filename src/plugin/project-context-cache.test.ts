/**
 * Resolving an account's project costs several round trips, so the outcome is
 * cached on disk as well as in memory. These tests pin the parts that are easy to
 * get wrong: the cache has to survive a fresh process, it has to skip the network
 * once warm, and it must never write a copy of a refresh token.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthAuthDetails } from "./types";

const REFRESH_TOKEN = "1//super-secret-refresh-token";

vi.mock("./storage", () => ({
  getConfigDir: () => configDir,
}));

let configDir = "";

async function freshModule() {
  vi.resetModules();
  return await import("./project");
}

function auth(refresh = REFRESH_TOKEN): OAuthAuthDetails {
  return { type: "oauth", access: "access-token", refresh };
}

/** Mirrors how the plugin keys its on-disk cache. */
function cacheKeyOf(refresh: string): string {
  return createHash("sha256").update(refresh).digest("hex");
}

/**
 * Stands in for loadCodeAssist: succeeds and reports a plan.
 *
 * It also names a project, which the plugin deliberately does not adopt. That
 * project is what generation is sent to when it is adopted, and requests fail
 * against it, so the tests pin the plan arriving and the project staying put.
 */
const IGNORED_PROJECT = "aicode-consumers";

function loadResponse(paidTierId = "g1-pro-tier", name = "Google AI Pro") {
  return {
    ok: true,
    json: async () => ({
      cloudaicompanionProject: { id: IGNORED_PROJECT },
      paidTier: { id: paidTierId, name },
    }),
  };
}

describe("project context disk cache", () => {
  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "opencode-project-cache-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => loadResponse()),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(configDir, { recursive: true, force: true });
  });

  it("reads the plan over the network the first time and writes a cache entry", async () => {
    const project = await freshModule();

    const result = await project.ensureProjectContext(auth());

    expect(result.subscription).toEqual({ id: "g1-pro-tier", name: "Google AI Pro" });
    expect(await readFile(join(configDir, "antigravity-project-context.json"), "utf8")).toContain(
      "g1-pro-tier",
    );
  });

  it("leaves the project alone even when the lookup names one", async () => {
    // Adopting the looked-up project sends generation to "aicode-consumers",
    // where every request comes back as an HTTP 400. The lookup is made for the
    // plan; the project is not its to change.
    const project = await freshModule();

    const result = await project.ensureProjectContext(auth());

    expect(result.effectiveProjectId).toBe("rising-fact-p41fc");
    expect(result.effectiveProjectId).not.toBe(IGNORED_PROJECT);
    expect(result.auth.refresh).not.toContain(IGNORED_PROJECT);
  });

  it("skips the network on a later run and still reports the plan", async () => {
    const first = await freshModule();
    await first.ensureProjectContext(auth());

    // A new module instance is what a new process sees: the in-memory maps start
    // empty, so only the file on disk can answer this.
    const second = await freshModule();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();

    const result = await second.ensureProjectContext(auth());

    expect(result.subscription).toEqual({ id: "g1-pro-tier", name: "Google AI Pro" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never writes the refresh token into the cache file", async () => {
    const project = await freshModule();
    await project.ensureProjectContext(auth());

    const raw = await readFile(join(configDir, "antigravity-project-context.json"), "utf8");
    expect(raw).not.toContain(REFRESH_TOKEN);
    // It is keyed by a digest instead.
    expect(raw).not.toContain("refresh");
  });

  it("ignores an unreadable cache file instead of failing the lookup", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(configDir, "antigravity-project-context.json"), "not json", "utf8");

    const project = await freshModule();
    const result = await project.ensureProjectContext(auth());

    expect(result.effectiveProjectId).toBe("rising-fact-p41fc");
  });

  it("keeps every account's entry when they resolve concurrently", async () => {
    // Accounts are checked in parallel, and each one writes the shared file with
    // a read-modify-write. Unserialised, the writes clobbered each other and the
    // accounts then missed the cache in rotation.
    const project = await freshModule();
    const tokens = ["token-a", "token-b", "token-c"];

    await Promise.all(
      tokens.map((token) => project.ensureProjectContext(auth(`${token}-refresh`))),
    );

    const cache = JSON.parse(
      await readFile(join(configDir, "antigravity-project-context.json"), "utf8"),
    );
    for (const token of tokens) {
      expect(Object.keys(cache)).toContain(cacheKeyOf(`${token}-refresh`));
    }
  });

  it("expires an entry instead of serving it forever", async () => {
    const first = await freshModule();
    await first.ensureProjectContext(auth());

    // Backdate the entry past its TTL. An account that gets provisioned later
    // must not keep being answered from the fallback recorded here.
    const path = join(configDir, "antigravity-project-context.json");
    const cache = JSON.parse(await readFile(path, "utf8"));
    for (const key of Object.keys(cache)) cache[key].cachedAt = 0;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify(cache), "utf8");

    const second = await freshModule();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();

    const result = await second.ensureProjectContext(auth());

    expect(fetchMock).toHaveBeenCalled();
    expect(result.effectiveProjectId).toBe("rising-fact-p41fc");
  });

  it("keeps the remembered project when a token refresh invalidates the cache", async () => {
    // Token refresh calls this after every access token renewal, and an access
    // token is short lived enough that a quota read renews one each time. If
    // this dropped the file too, the cache could never be reused.
    const project = await freshModule();
    await project.ensureProjectContext(auth());

    project.invalidateProjectContextCache(REFRESH_TOKEN);

    const cache = JSON.parse(await readFile(join(configDir, "antigravity-project-context.json"), "utf8"));
    expect(Object.keys(cache)).toContain(cacheKeyOf(REFRESH_TOKEN));
  });

  it("discards the file on an explicit reset", async () => {
    const project = await freshModule();
    await project.ensureProjectContext(auth());

    await project.clearPersistedProjectContext();

    const cache = JSON.parse(await readFile(join(configDir, "antigravity-project-context.json"), "utf8"));
    expect(Object.keys(cache)).toHaveLength(0);
  });
});
