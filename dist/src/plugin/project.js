import { getAntigravityHeaders, ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_LOAD_ENDPOINTS, ANTIGRAVITY_DEFAULT_PROJECT_ID, } from "../constants";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { createLogger } from "./logger";
import { getConfigDir } from "./storage";
const log = createLogger("project");
const projectContextResultCache = new Map();
const projectContextPendingCache = new Map();
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
function cacheFilePath() {
    return join(getConfigDir(), PROJECT_CONTEXT_CACHE_FILE);
}
/** Refresh tokens are secrets, so the cache is keyed by a digest, not the token. */
function cacheKeyHash(refresh) {
    return createHash("sha256").update(refresh).digest("hex");
}
/** Re-applies a cached project resolution onto the caller's current auth. */
function restoreFromCache(auth, cached) {
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
        };
    }
    return { auth, effectiveProjectId: cached.effectiveProjectId };
}
async function readProjectContextCache() {
    try {
        const raw = await readFile(cacheFilePath(), "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        return parsed;
    }
    catch {
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
let cacheWriteQueue = Promise.resolve();
/** Runs `task` after every previously queued cache write has settled. */
function enqueueCacheWrite(task) {
    const result = cacheWriteQueue.then(task, task);
    // Keep the chain alive regardless of the outcome of this task.
    cacheWriteQueue = result.catch(() => { });
    return result;
}
async function writeProjectContextCache(key, value) {
    await enqueueCacheWrite(async () => {
        try {
            const cache = await readProjectContextCache();
            cache[key] = value;
            const path = cacheFilePath();
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
        }
        catch (error) {
            // Caching is an optimisation: losing it only costs the slower lookup.
            log.debug("Failed to persist project context cache", { error: String(error) });
        }
    });
}
const CODE_ASSIST_METADATA = {
    ideType: "ANTIGRAVITY",
    platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
    pluginType: "GEMINI",
};
function buildMetadata(projectId) {
    const metadata = {
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
 * Selects the default tier ID from the allowed tiers list.
 */
function getDefaultTierId(allowedTiers) {
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
function wait(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}
/**
 * Extracts the cloudaicompanion project id from loadCodeAssist responses.
 */
function extractManagedProjectId(payload) {
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
function getCacheKey(auth) {
    const refresh = auth.refresh?.trim();
    return refresh ? refresh : undefined;
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
export function invalidateProjectContextCache(refresh) {
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
export async function clearPersistedProjectContext() {
    await forgetProjectContextCache();
}
/** Removes one account's remembered project, or all of them. */
async function forgetProjectContextCache(refresh) {
    await enqueueCacheWrite(async () => {
        try {
            const cache = await readProjectContextCache();
            if (refresh) {
                delete cache[cacheKeyHash(refresh)];
            }
            else {
                for (const key of Object.keys(cache))
                    delete cache[key];
            }
            const path = cacheFilePath();
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
        }
        catch (error) {
            log.debug("Failed to clear project context cache", { error: String(error) });
        }
    });
}
/**
 * Loads managed project information for the given access token and optional project.
 */
export async function loadManagedProject(accessToken, projectId) {
    const metadata = buildMetadata(projectId);
    const requestBody = { metadata };
    const loadHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "google-api-nodejs-client/9.15.1",
        "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "Client-Metadata": getAntigravityHeaders()["Client-Metadata"],
    };
    const loadEndpoints = Array.from(new Set([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS]));
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
            if (!response.ok)
                return { baseEndpoint, payload: null };
            return { baseEndpoint, payload: (await response.json()) };
        }
        catch (error) {
            log.debug("Failed to load managed project", { endpoint: baseEndpoint, error: String(error) });
            return { baseEndpoint, payload: null };
        }
        finally {
            clearTimeout(timeout);
        }
    });
    const settled = await Promise.all(attempts);
    for (const attempt of settled) {
        if (attempt.payload)
            return attempt.payload;
    }
    return null;
}
/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export async function onboardManagedProject(accessToken, tierId, projectId, attempts = 10, delayMs = 5000) {
    const metadata = buildMetadata(projectId);
    const requestBody = {
        tierId,
        metadata,
    };
    for (const baseEndpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const response = await fetch(`${baseEndpoint}/v1internal:onboardUser`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${accessToken}`,
                        ...getAntigravityHeaders(),
                    },
                    body: JSON.stringify(requestBody),
                });
                if (!response.ok) {
                    break;
                }
                const payload = (await response.json());
                const managedProjectId = payload.response?.cloudaicompanionProject?.id;
                if (payload.done && managedProjectId) {
                    return managedProjectId;
                }
                if (payload.done && projectId) {
                    return projectId;
                }
            }
            catch (error) {
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
export async function ensureProjectContext(auth) {
    const accessToken = auth.access;
    if (!accessToken) {
        return { auth, effectiveProjectId: "" };
    }
    const cacheKey = getCacheKey(auth);
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
        const persisted = (await readProjectContextCache())[cacheKeyHash(cacheKey)];
        if (persisted && Date.now() - persisted.cachedAt < PROJECT_CONTEXT_TTL_MS) {
            const restored = restoreFromCache(auth, persisted);
            projectContextResultCache.set(cacheKey, restored);
            return restored;
        }
    }
    const resolveContext = async () => {
        const parts = parseRefreshParts(auth.refresh);
        if (parts.managedProjectId) {
            return { auth, effectiveProjectId: parts.managedProjectId };
        }
        const fallbackProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
        const persistManagedProject = async (managedProjectId) => {
            const updatedAuth = {
                ...auth,
                refresh: formatRefreshParts({
                    refreshToken: parts.refreshToken,
                    projectId: parts.projectId,
                    managedProjectId,
                }),
            };
            return { auth: updatedAuth, effectiveProjectId: managedProjectId };
        };
        // Try to resolve a managed project from Antigravity if possible.
        const loadPayload = await loadManagedProject(accessToken, parts.projectId ?? fallbackProjectId);
        const resolvedManagedProjectId = extractManagedProjectId(loadPayload);
        if (resolvedManagedProjectId) {
            return persistManagedProject(resolvedManagedProjectId);
        }
        // No managed project found - try to auto-provision one via onboarding.
        // This handles accounts that were added before managed project provisioning was required.
        const tierId = getDefaultTierId(loadPayload?.allowedTiers) ?? "FREE";
        log.debug("Auto-provisioning managed project", { tierId, projectId: parts.projectId });
        const provisionedProjectId = await onboardManagedProject(accessToken, tierId, parts.projectId);
        if (provisionedProjectId) {
            log.debug("Successfully provisioned managed project", { provisionedProjectId });
            return persistManagedProject(provisionedProjectId);
        }
        log.warn("Failed to provision managed project - account may not work correctly", {
            hasProjectId: !!parts.projectId,
        });
        if (parts.projectId) {
            return { auth, effectiveProjectId: parts.projectId };
        }
        // No project id present in auth; fall back to the hardcoded id for requests.
        return { auth, effectiveProjectId: fallbackProjectId };
    };
    if (!cacheKey) {
        return resolveContext();
    }
    const promise = resolveContext()
        .then(async (result) => {
        const nextKey = getCacheKey(result.auth) ?? cacheKey;
        projectContextPendingCache.delete(cacheKey);
        projectContextResultCache.set(nextKey, result);
        if (nextKey !== cacheKey) {
            projectContextResultCache.delete(cacheKey);
        }
        // Persist the outcome under both keys: the lookup may have produced a
        // managed project, which rewrites the refresh token, so the next process
        // would otherwise look the account up under a different key.
        const parts = parseRefreshParts(result.auth.refresh);
        for (const key of new Set([cacheKey, nextKey])) {
            await writeProjectContextCache(cacheKeyHash(key), {
                cachedAt: Date.now(),
                effectiveProjectId: result.effectiveProjectId,
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
//# sourceMappingURL=project.js.map