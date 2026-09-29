import {
  getAntigravityHeaders,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
} from "../constants";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { createLogger } from "./logger";
import { getConfigDir } from "./storage";
import type { OAuthAuthDetails, ProjectContextResult } from "./types";

const log = createLogger("project");

const projectContextResultCache = new Map<string, ProjectContextResult>();
const projectContextPendingCache = new Map<string, Promise<ProjectContextResult>>();

/**
 * Budget for a single project lookup. Without it an endpoint that accepts the
 * connection and then stalls holds up the whole read until the process gives up.
 */
const LOAD_TIMEOUT_MS = 8000;

/**
 * Resolving an account's project costs several round trips, and the result only
 * depends on the account, so the in-memory cache above is not enough on its own:
 * it is empty again in every new process, which meant each run of the CLI menu or
 * a quota read paid the full lookup again. This keeps the outcome on disk next to
 * the account file, keyed by a hash of the refresh token so no new copy of a
 * secret is written out.
 *
 * Only the resolved project ids are stored. A rotated refresh token is never
 * cached here: the caller still re-reads it from the account file and the token
 * itself is never persisted in this file.
 */
const PROJECT_CONTEXT_CACHE_FILE = "antigravity-project-context.json";

/**
 * How long a remembered project stays valid.
 *
 * The entry is a cache, not a source of truth: the accounts these accounts fall
 * back to the default project can be provisioned later through the CLI menu, and
 * a cache that outlived that would keep serving the fallback. A day is far more
 * than a session needs and short enough that such a change takes effect on its
 * own.
 */
const PROJECT_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

/** What is remembered about one account's project. */
interface CachedProjectContext {
  /** When this entry was written, used to expire it. */
  cachedAt: number;
  /** Project the quota calls are made against. */
  effectiveProjectId: string;
  /** Present when discovery or onboarding produced a managed project. */
  managedProjectId?: string;
  /** Project id already on the account, kept so it can be restored onto the auth. */
  projectId?: string;
  /** The plan the account is entitled to, when the lookup reported one. */
  subscription?: { id: string; name?: string };
  /** Project the weekly allowance is served under. */
  consumerProjectId?: string;
}

type ProjectContextCacheFile = Record<string, CachedProjectContext>;

function cacheFilePath(): string {
  return join(getConfigDir(), PROJECT_CONTEXT_CACHE_FILE);
}

/** Refresh tokens are secrets, so the cache is keyed by a digest, not the token. */
function cacheKeyHash(refresh: string): string {
  return createHash("sha256").update(refresh).digest("hex");
}

/** Re-applies a cached project resolution onto the caller's current auth. */
function restoreFromCache(auth: OAuthAuthDetails, cached: CachedProjectContext): ProjectContextResult {
  const plan = cached.subscription;
  const parts = parseRefreshParts(auth.refresh);
  if (cached.managedProjectId && parts.refreshToken) {
    return {
      auth: {
        ...auth,
        refresh: formatRefreshParts({
          refreshToken: parts.refreshToken,
          projectId: cached.projectId,
          managedProjectId: cached.managedProjectId,
        }),
      },
      effectiveProjectId: cached.effectiveProjectId,
      // Carried back, or a warmed account would come back with its project but
      // no plan, which reads as an account that is not a subscription.
      ...(plan ? { subscription: plan } : {}),
      // Likewise for the consumer project: without it the weekly allowance is not
      // read at all, so a warm read would report the five-hour window alone and
      // a subscription account would look like it only has that one.
      ...(cached.consumerProjectId ? { consumerProjectId: cached.consumerProjectId } : {}),
    };
  }
  return {
    auth,
    effectiveProjectId: cached.effectiveProjectId,
    ...(plan ? { subscription: plan } : {}),
    ...(cached.consumerProjectId ? { consumerProjectId: cached.consumerProjectId } : {}),
  };
}

async function readProjectContextCache(): Promise<ProjectContextCacheFile> {
  try {
    const raw = await readFile(cacheFilePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ProjectContextCacheFile;
  } catch {
    // A missing or unreadable cache is not an error; it just means a full lookup.
    return {};
  }
}

/**
 * Serialises cache writes.
 *
 * Each write is a read-modify-write of one file, and accounts are resolved
 * concurrently, so unserialised writes raced: each one read the file before
 * another had written, and the last write to land discarded the entries the
 * others had just added. That made accounts miss the cache in rotation instead
 * of all of them hitting it.
 */
let cacheWriteQueue: Promise<unknown> = Promise.resolve();

/** Runs `task` after every previously queued cache write has settled. */
function enqueueCacheWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = cacheWriteQueue.then(task, task);
  // Keep the chain alive regardless of the outcome of this task.
  cacheWriteQueue = result.catch(() => {});
  return result;
}

async function writeProjectContextCache(key: string, value: CachedProjectContext): Promise<void> {
  await enqueueCacheWrite(async () => {
    try {
      const cache = await readProjectContextCache();
      cache[key] = value;
      const path = cacheFilePath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    } catch (error) {
      // Caching is an optimisation: losing it only costs the slower lookup.
      log.debug("Failed to persist project context cache", { error: String(error) });
    }
  });
}

/**
 * Metadata for the loadCodeAssist call.
 *
 * Only `ideType` is sent. Adding `platform` and `pluginType` makes Google answer
 * 400, so the call fails and the account silently falls back to the default
 * project with no tier, which is what hid the subscription from the quota
 * report. Verified by trying the shapes: `{ideType}` answers 200, the fuller one
 * answers 400.
 */
const LOAD_CODE_ASSIST_METADATA = {
  ideType: "ANTIGRAVITY",
} as const;

const CODE_ASSIST_METADATA = {
  ideType: "ANTIGRAVITY",
  platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
  pluginType: "GEMINI",
} as const;

interface AntigravityUserTier {
  id?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean;
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | { id?: string };
  currentTier?: {
    id?: string;
  };
  allowedTiers?: AntigravityUserTier[];
  /**
   * The plan the account is entitled to.
   *
   * `currentTier` is "free-tier" even for a paid subscription, so it does not
   * say whether the account is one. `paidTier` does: "g1-pro-tier" for Google AI
   * Pro, "free-tier" otherwise.
   */
  paidTier?: {
    id?: string;
    name?: string;
  };
}

interface OnboardUserPayload {
  done?: boolean;
  response?: {
    cloudaicompanionProject?: {
      id?: string;
    };
  };
}

/**
 * Metadata for the loadCodeAssist call.
 *
 * Only `ideType` is sent here. See LOAD_CODE_ASSIST_METADATA for why the extra
 * fields cannot be included.
 */
function buildMetadata(): Record<string, string> {
  return { ideType: LOAD_CODE_ASSIST_METADATA.ideType };
}

/** Metadata for the onboard call, which does take the richer shape. */
function buildOnboardMetadata(projectId?: string): Record<string, string> {
  const metadata: Record<string, string> = {
    ideType: CODE_ASSIST_METADATA.ideType,
    platform: CODE_ASSIST_METADATA.platform,
    pluginType: CODE_ASSIST_METADATA.pluginType,
  };
  if (projectId) {
    metadata.duetProject = projectId;
  }
  return metadata;
}

/**
 * Reads the plan an account is entitled to.
 *
 * `paidTier` is the field that answers this. `currentTier` reports "free-tier"
 * even for a paid subscription, so on its own it cannot tell one from the other.
 */
/**
 * The consumer project the lookup names.
 *
 * Only used to ask for the weekly allowance, which the autopush host serves under
 * this project and not under the one requests are made with.
 */
function readConsumerProjectId(payload: LoadCodeAssistPayload | null): string | undefined {
  return extractManagedProjectId(payload);
}

function readPaidTier(payload: LoadCodeAssistPayload | null): ProjectContextResult["subscription"] {
  const id = payload?.paidTier?.id;
  if (!id) return undefined;
  const name = payload?.paidTier?.name;
  return { id, ...(name ? { name } : {}) };
}

/**
 * Selects the default tier ID from the allowed tiers list.
 */
function getDefaultTierId(allowedTiers?: AntigravityUserTier[]): string | undefined {
  if (!allowedTiers || allowedTiers.length === 0) {
    return undefined;
  }
  for (const tier of allowedTiers) {
    if (tier?.isDefault) {
      return tier.id;
    }
  }
  return allowedTiers[0]?.id;
}

/**
 * Promise-based delay utility.
 */
function wait(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Extracts the cloudaicompanion project id from loadCodeAssist responses.
 */
function extractManagedProjectId(payload: LoadCodeAssistPayload | null): string | undefined {
  if (!payload) {
    return undefined;
  }
  if (typeof payload.cloudaicompanionProject === "string") {
    return payload.cloudaicompanionProject;
  }
  if (payload.cloudaicompanionProject && typeof payload.cloudaicompanionProject.id === "string") {
    return payload.cloudaicompanionProject.id;
  }
  return undefined;
}

/**
 * Generates a cache key for project context based on refresh token.
 */
function getCacheKey(auth: OAuthAuthDetails): string | undefined {
  const refresh = auth.refresh?.trim();
  return refresh ? refresh : undefined;
}

/**
 * The stable part of a refresh token, used as the cache key.
 *
 * A refresh token can carry the resolved project appended to it, and resolving
 * rewrites it, so keying on the whole string meant an account that had been
 * resolved once was looked up under a different key than before and never found
 * its own entry. The bare token does not change, and the project is exactly the
 * thing the entry holds.
 */
function getStableCacheKey(auth: OAuthAuthDetails): string | undefined {
  const parts = parseRefreshParts(auth.refresh);
  return parts.refreshToken || undefined;
}

/**
 * Clears cached project context results and pending promises, globally or for a refresh key.
 */
/**
 * Forgets resolved projects in memory.
 *
 * The on-disk entries are deliberately left alone. This is called after every
 * access token refresh, and an access token is short lived enough that reading
 * quota refreshes one every time, so dropping the file here meant the cache was
 * erased before it could ever be reused. Nothing secret is stored there: an
 * entry is a project id keyed by a digest of the refresh token, and a refresh
 * token that actually rotated simply leaves behind an entry nothing reads.
 * Use `clearPersistedProjectContext` to discard the file on purpose.
 */
export function invalidateProjectContextCache(refresh?: string): void {
  if (!refresh) {
    projectContextPendingCache.clear();
    projectContextResultCache.clear();
    return;
  }
  projectContextPendingCache.delete(refresh);
  projectContextResultCache.delete(refresh);
}

/**
 * Discards every remembered project on disk.
 *
 * Not wired to token refresh; this is for a deliberate reset, such as after
 * reprovisioning an account.
 */
export async function clearPersistedProjectContext(): Promise<void> {
  await forgetProjectContextCache();
}

/** Removes one account's remembered project, or all of them. */
async function forgetProjectContextCache(refresh?: string): Promise<void> {
  await enqueueCacheWrite(async () => {
    try {
      const cache = await readProjectContextCache();
      if (refresh) {
        delete cache[cacheKeyHash(refresh)];
      } else {
        for (const key of Object.keys(cache)) delete cache[key];
      }
      const path = cacheFilePath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    } catch (error) {
      log.debug("Failed to clear project context cache", { error: String(error) });
    }
  });
}

/**
 * Loads managed project information for the given access token and optional project.
 */
export async function loadManagedProject(
  accessToken: string,
  projectId?: string,
): Promise<LoadCodeAssistPayload | null> {
  const metadata = buildMetadata();
  const requestBody: Record<string, unknown> = { metadata };

  const loadHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    // The Antigravity User-Agent, not the Google API client's. Asked as the
    // Google client the endpoint answers 200 with a body that has no
    // currentTier and no paidTier in it, so the account's plan was never
    // reported and the lookup looked like it had nothing to say.
    "User-Agent": getAntigravityHeaders()["User-Agent"] ?? "antigravity/windows/amd64",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": getAntigravityHeaders()["Client-Metadata"],
  };

  const loadEndpoints = Array.from(
    new Set<string>([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS]),
  );

  // All candidates are independent, and the first one that answers decides the
  // project. Trying them one after another made every read pay for the
  // round trips of the endpoints ahead of the winner, which was several seconds
  // per account; running them together costs one round trip instead. The
  // endpoints are ordered, so the highest priority answer still wins.
  const attempts = loadEndpoints.map(async (baseEndpoint) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseEndpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: loadHeaders,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) return { baseEndpoint, payload: null };

      return { baseEndpoint, payload: (await response.json()) as LoadCodeAssistPayload };
    } catch (error) {
      log.debug("Failed to load managed project", { endpoint: baseEndpoint, error: String(error) });
      return { baseEndpoint, payload: null };
    } finally {
      clearTimeout(timeout);
    }
  });

  const settled = await Promise.all(attempts);
  for (const attempt of settled) {
    if (attempt.payload) return attempt.payload;
  }

  return null;
}


/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export async function onboardManagedProject(
  accessToken: string,
  tierId: string,
  projectId?: string,
  attempts = 10,
  delayMs = 5000,
): Promise<string | undefined> {
  const metadata = buildOnboardMetadata(projectId);
  const requestBody: Record<string, unknown> = {
    tierId,
    metadata,
  };

  for (const baseEndpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(
          `${baseEndpoint}/v1internal:onboardUser`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
              ...getAntigravityHeaders(),
            },
            body: JSON.stringify(requestBody),
          },
        );

        if (!response.ok) {
          break;
        }

        const payload = (await response.json()) as OnboardUserPayload;
        const managedProjectId = payload.response?.cloudaicompanionProject?.id;
        if (payload.done && managedProjectId) {
          return managedProjectId;
        }
        if (payload.done && projectId) {
          return projectId;
        }
      } catch (error) {
        log.debug("Failed to onboard managed project", { endpoint: baseEndpoint, error: String(error) });
        break;
      }

      await wait(delayMs);
    }
  }

  return undefined;
}

/**
 * Resolves an effective project ID for the current auth state, caching results per refresh token.
 */
export async function ensureProjectContext(auth: OAuthAuthDetails): Promise<ProjectContextResult> {
  const accessToken = auth.access;
  if (!accessToken) {
    return { auth, effectiveProjectId: "" };
  }

  const cacheKey = getCacheKey(auth);
  // Stable across project resolution, so an account that already resolved its
  // project still finds what was remembered about it.
  const stableKey = getStableCacheKey(auth);
  if (cacheKey) {
    const cached = projectContextResultCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = projectContextPendingCache.get(cacheKey);
    if (pending) {
      return pending;
    }

    // The in-memory maps are empty in a fresh process, so fall back to what the
    // last one learned before paying for the lookup again.
    const persisted = (await readProjectContextCache())[cacheKeyHash(stableKey ?? cacheKey)];
    if (persisted && Date.now() - persisted.cachedAt < PROJECT_CONTEXT_TTL_MS) {
      const restored = restoreFromCache(auth, persisted);
      projectContextResultCache.set(cacheKey, restored);
      return restored;
    }
  }

  const resolveContext = async (): Promise<ProjectContextResult> => {
    const parts = parseRefreshParts(auth.refresh);
    if (parts.managedProjectId) {
      // The project is already settled, so there is nothing here to resolve. The
      // same call is still the only thing that reports the plan, though, and
      // returning early left every account looking like it had no plan at all.
      // It runs once, then the plan is read from the cache like anything else.
      const known: ProjectContextResult = { auth, effectiveProjectId: parts.managedProjectId };
      const remembered = (await readProjectContextCache())[cacheKeyHash(stableKey ?? auth.refresh.trim())];
      if (remembered?.subscription) return { ...known, subscription: remembered.subscription };

      const payload = await loadManagedProject(accessToken, parts.projectId ?? parts.managedProjectId);
      const subscription = readPaidTier(payload);
      const consumerProjectId = readConsumerProjectId(payload);
      if (!subscription && !consumerProjectId) return known;
      await writeProjectContextCache(cacheKeyHash(stableKey ?? auth.refresh.trim()), {
        cachedAt: Date.now(),
        effectiveProjectId: parts.managedProjectId,
        subscription,
        consumerProjectId,
      });
      return { ...known, subscription, consumerProjectId };
    }

    // The lookup is made for the plan, not for a project.
    //
    // It used to be made to discover or provision a managed project, and the
    // project it answered with was then used for requests. That is what this
    // code did before the request was fixed to answer at all: with the request
    // failing, every account fell back to the default project and requests
    // worked. Once the request started answering, requests went to the project
    // it names, "aicode-consumers", and every generation came back as an HTTP
    // 400. So the answer is read for the plan and the project stays as it was.
    //
    // This also drops the auto-provisioning attempt, which spent up to a minute
    // of retries per account on first read to produce a project nothing uses.
    const fallbackProjectId = parts.projectId || ANTIGRAVITY_DEFAULT_PROJECT_ID;
    const loadPayload = await loadManagedProject(accessToken, fallbackProjectId);
    const subscription = readPaidTier(loadPayload);

    const consumerProjectId = readConsumerProjectId(loadPayload);
    return {
      auth,
      effectiveProjectId: fallbackProjectId,
      ...(subscription ? { subscription } : {}),
      ...(consumerProjectId ? { consumerProjectId } : {}),
    };
  };

  if (!cacheKey) {
    return resolveContext();
  }

  const promise = resolveContext()
    .then(async (result) => {
      const nextKey = getStableCacheKey(result.auth) ?? cacheKey;
      projectContextPendingCache.delete(cacheKey);
      projectContextResultCache.set(nextKey, result);
      if (nextKey !== cacheKey) {
        projectContextResultCache.delete(cacheKey);
      }

      // Only a plan is worth remembering. The project no longer comes from this
      // lookup, so an entry without a plan holds nothing that a later fix to the
      // request would not change, and caching it would keep the cache from
      // picking up that fix for a whole TTL.
      // Only the plan and the consumer project are worth remembering. The project
      // requests are made with no longer comes from here, so an entry without them
      // holds nothing a later fix to the request would not change, and caching it
      // would keep the cache from picking up that fix for a whole TTL.
      if (!result.subscription && !result.consumerProjectId) return result;

      // Persist the outcome under both keys: the lookup may have produced a
      // managed project, which rewrites the refresh token, so the next process
      // would otherwise look the account up under a different key.
      const parts = parseRefreshParts(result.auth.refresh);
      for (const key of new Set([cacheKey, nextKey])) {
        await writeProjectContextCache(cacheKeyHash(key), {
          cachedAt: Date.now(),
          effectiveProjectId: result.effectiveProjectId,
          ...(result.subscription ? { subscription: result.subscription } : {}),
          // The weekly allowance is only served on the autopush host when asked
          // with this project, so a warm read that has forgotten it reports the
          // five-hour window alone and looks like the account has just the one.
          ...(result.consumerProjectId ? { consumerProjectId: result.consumerProjectId } : {}),
          ...(parts.managedProjectId ? { managedProjectId: parts.managedProjectId } : {}),
          ...(parts.projectId ? { projectId: parts.projectId } : {}),
        });
      }

      return result;
    })
    .catch((error) => {
      projectContextPendingCache.delete(cacheKey);
      throw error;
    });

  projectContextPendingCache.set(cacheKey, promise);
  return promise;
}
