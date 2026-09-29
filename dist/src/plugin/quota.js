import { ANTIGRAVITY_ENDPOINT_AUTOPUSH, ANTIGRAVITY_ENDPOINT_PROD, getAntigravityHeaders, ANTIGRAVITY_PROVIDER_ID, } from "../constants";
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./auth";
import { logQuotaFetch, logQuotaStatus } from "./debug";
import { ensureProjectContext } from "./project";
import { refreshAccessToken } from "./token";
import { getModelFamily } from "./transform/model-resolver";
const FETCH_TIMEOUT_MS = 10000;
function buildAuthFromAccount(account) {
    return {
        type: "oauth",
        refresh: formatRefreshParts({
            refreshToken: account.refreshToken,
            projectId: account.projectId,
            managedProjectId: account.managedProjectId,
        }),
        access: undefined,
        expires: undefined,
    };
}
function normalizeRemainingFraction(value) {
    // If value is missing or invalid, treat as exhausted (0%)
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 0;
    }
    if (value < 0)
        return 0;
    if (value > 1)
        return 1;
    return value;
}
function parseResetTime(resetTime) {
    if (!resetTime)
        return null;
    const timestamp = Date.parse(resetTime);
    if (!Number.isFinite(timestamp)) {
        return null;
    }
    return timestamp;
}
function classifyQuotaGroup(modelName, displayName) {
    const combined = `${modelName} ${displayName ?? ""}`.toLowerCase();
    if (combined.includes("claude")) {
        return "claude";
    }
    const isGemini3 = combined.includes("gemini-3") || combined.includes("gemini 3");
    if (!isGemini3) {
        return null;
    }
    const family = getModelFamily(modelName);
    return family === "gemini-flash" ? "gemini-flash" : "gemini-pro";
}
/**
 * Groups the model list into families and windows.
 *
 * The fallback for when the buckets do not answer. A model here carries a single
 * quota reading, so a family ends up with one window per distinct reset among its
 * models, which is the same shape the buckets produce and lets both readings be
 * rendered the same way.
 */
function aggregateQuota(models) {
    const buckets = [];
    for (const [modelName, entry] of Object.entries(models ?? {})) {
        if (!classifyQuotaGroup(modelName, entry.displayName ?? entry.modelName)) {
            continue;
        }
        const quotaInfo = entry.quotaInfo;
        buckets.push({
            modelId: modelName,
            ...(quotaInfo?.remainingFraction !== undefined
                ? { remainingFraction: quotaInfo.remainingFraction }
                : {}),
            ...(quotaInfo?.resetTime ? { resetTime: quotaInfo.resetTime } : {}),
        });
    }
    return aggregateBuckets({ buckets });
}
async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    }
    finally {
        clearTimeout(timeout);
    }
}
async function fetchAvailableModels(accessToken, projectId) {
    const endpoint = ANTIGRAVITY_ENDPOINT_PROD;
    const quotaUserAgent = getAntigravityHeaders()["User-Agent"] || "antigravity/windows/amd64";
    const errors = [];
    const body = projectId ? { project: projectId } : {};
    const response = await fetchWithTimeout(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": quotaUserAgent,
        },
        body: JSON.stringify(body),
    });
    if (response.ok) {
        return (await response.json());
    }
    const message = await response.text().catch(() => "");
    const snippet = message.trim().slice(0, 200);
    errors.push(`fetchAvailableModels ${response.status} at ${endpoint}${snippet ? `: ${snippet}` : ""}`);
    throw new Error(errors.join("; ") || "fetchAvailableModels failed");
}
/**
 * Reads every allowance window an account has.
 *
 * The windows are not all on the same host. The five-hour window is served by the
 * production host, while the weekly one is only served by the autopush host, and
 * only when asked with the consumer project the account lookup names: the same
 * call with the project requests are made with answers 403 there. Asking one host
 * and reporting what came back is why a subscription account used to look like it
 * had a single window when it has two.
 *
 * Both sets are merged rather than one being preferred. A model can appear in
 * both with the same reset, which is one window reported twice, and with different
 * resets, which is two windows for the same model, so buckets are keyed by model
 * and reset together and the later host only fills gaps.
 */
async function fetchQuotaBuckets(accessToken, projectId, consumerProjectId) {
    const antigravityHeaders = getAntigravityHeaders();
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        // Asked as Antigravity. Asked as the Gemini CLI this same call answers 403
        // SUBSCRIPTION_REQUIRED, which reads like the account has no quota at all, so
        // the whole bucket set was being discarded and every account reported none.
        "User-Agent": antigravityHeaders["User-Agent"] ?? "antigravity/windows/amd64",
        "X-Goog-Api-Client": antigravityHeaders["X-Goog-Api-Client"] ?? "",
        "Client-Metadata": antigravityHeaders["Client-Metadata"],
    };
    const ask = async (host, project) => {
        const response = await fetchWithTimeout(`${host}/v1internal:retrieveUserQuota`, {
            method: "POST",
            headers,
            body: JSON.stringify({ project }),
        });
        if (!response.ok)
            return [];
        const data = (await response.json());
        return data.buckets ?? [];
    };
    try {
        const targets = [[ANTIGRAVITY_ENDPOINT_PROD, projectId]];
        if (consumerProjectId && consumerProjectId !== projectId) {
            targets.push([ANTIGRAVITY_ENDPOINT_AUTOPUSH, consumerProjectId]);
        }
        const seen = new Set();
        const buckets = [];
        for (const [host, project] of targets) {
            for (const bucket of await ask(host, project)) {
                if (!bucket.modelId)
                    continue;
                // Keyed by both, because the same model on two windows is two allowances
                // and the same model twice on one window is one.
                const key = `${bucket.modelId}@${bucket.resetTime ?? ""}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                buckets.push(bucket);
            }
        }
        return { buckets };
    }
    catch {
        // Network error or timeout - return empty buckets
        return { buckets: [] };
    }
}
/**
 * Groups allowances by family and by the window they refill on.
 *
 * A window is identified by its reset rather than by its length: two allowances
 * that refill at the same moment are on the same window, and ones that differ are
 * not whatever their length rounds to. Within a window the group reports the
 * lowest allowance in it, since that is the one that decides when the account
 * runs out.
 */
function aggregateBuckets(response) {
    const groups = {};
    const seenModels = new Set();
    let totalCount = 0;
    for (const bucket of response.buckets ?? []) {
        if (!bucket.modelId)
            continue;
        const group = classifyQuotaGroup(bucket.modelId);
        if (!group)
            continue;
        totalCount += 1;
        seenModels.add(group);
        const key = bucket.resetTime ?? "";
        const existing = groups[group];
        const current = existing?.windows.find((window) => (window.resetTime ?? "") === key);
        const remainingFraction = normalizeRemainingFraction(bucket.remainingFraction);
        if (current) {
            if (remainingFraction < (current.remainingFraction ?? 1)) {
                current.remainingFraction = remainingFraction;
            }
            current.modelCount += 1;
            continue;
        }
        const window = {
            modelCount: 1,
            ...(remainingFraction !== undefined ? { remainingFraction } : {}),
            ...(bucket.resetTime ? { resetTime: bucket.resetTime } : {}),
        };
        groups[group] = {
            windows: [...(existing?.windows ?? []), window],
            modelCount: (existing?.modelCount ?? 0) + 1,
        };
    }
    // Soonest first, so the window that frees up first is the one read first.
    for (const summary of Object.values(groups)) {
        if (!summary)
            continue;
        summary.windows.sort((a, b) => {
            const at = Date.parse(a.resetTime ?? "");
            const bt = Date.parse(b.resetTime ?? "");
            if (Number.isFinite(at) && Number.isFinite(bt))
                return at - bt;
            return Number.isFinite(at) ? -1 : Number.isFinite(bt) ? 1 : 0;
        });
    }
    return { groups, modelCount: totalCount };
}
function applyAccountUpdates(account, auth) {
    const parts = parseRefreshParts(auth.refresh);
    if (!parts.refreshToken) {
        return undefined;
    }
    const updated = {
        ...account,
        refreshToken: parts.refreshToken,
        projectId: parts.projectId ?? account.projectId,
        managedProjectId: parts.managedProjectId ?? account.managedProjectId,
    };
    const changed = updated.refreshToken !== account.refreshToken ||
        updated.projectId !== account.projectId ||
        updated.managedProjectId !== account.managedProjectId;
    return changed ? updated : undefined;
}
/**
 * How many accounts to check at once.
 *
 * Each account needs a token refresh, a project-context lookup and two quota
 * round trips, and the accounts are independent, so running them one after
 * another made the wait grow with the number of accounts. The cap keeps a large
 * account pool from opening a burst of simultaneous requests at Google.
 */
const QUOTA_CONCURRENCY = 4;
/** Runs `worker` over `items` with a bounded number of calls in flight. */
async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runner = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
    return results;
}
export async function checkAccountsQuota(accounts, client, providerId = ANTIGRAVITY_PROVIDER_ID) {
    logQuotaFetch("start", accounts.length);
    const results = await mapWithConcurrency(accounts, QUOTA_CONCURRENCY, async (account, index) => checkAccountQuota(account, index, client, providerId));
    logQuotaFetch("complete", accounts.length, `ok=${results.filter(r => r.status === "ok").length} errors=${results.filter(r => r.status === "error").length}`);
    return results;
}
async function checkAccountQuota(account, index, client, providerId) {
    {
        const disabled = account.enabled === false;
        let subscription;
        let auth = buildAuthFromAccount(account);
        try {
            if (accessTokenExpired(auth)) {
                const refreshed = await refreshAccessToken(auth, client, providerId);
                if (!refreshed) {
                    throw new Error("Token refresh failed");
                }
                auth = refreshed;
            }
            const projectContext = await ensureProjectContext(auth);
            auth = projectContext.auth;
            subscription = projectContext.subscription;
            const updatedAccount = applyAccountUpdates(account, auth);
            // The buckets are the reading: they carry every window, including the
            // weekly one that only the autopush host serves. The model list is fetched
            // alongside as a fallback, since it is what a reading is built from when the
            // buckets do not answer.
            const [modelsResponse, bucketsResponse] = await Promise.all([
                fetchAvailableModels(auth.access ?? "", projectContext.effectiveProjectId).catch(() => ({ models: undefined })),
                fetchQuotaBuckets(auth.access ?? "", projectContext.effectiveProjectId, projectContext.consumerProjectId),
            ]);
            const fromBuckets = aggregateBuckets(bucketsResponse);
            const quotaResult = fromBuckets.modelCount > 0
                ? fromBuckets
                : modelsResponse.models === undefined
                    ? { groups: {}, modelCount: 0, error: "Failed to fetch Antigravity quota" }
                    : aggregateQuota(modelsResponse.models);
            // Log quota status for each family
            for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
                for (const window of groupQuota?.windows ?? []) {
                    logQuotaStatus(account.email, index, (window.remainingFraction ?? 0) * 100, family);
                }
            }
            return {
                index,
                email: account.email,
                status: "ok",
                disabled,
                quota: quotaResult,
                updatedAccount,
                ...(subscription ? { subscription } : {}),
            };
        }
        catch (error) {
            logQuotaFetch("error", undefined, `account=${account.email ?? index} error=${error instanceof Error ? error.message : String(error)}`);
            return {
                index,
                email: account.email,
                status: "error",
                disabled,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}
/**
 * The per-account quota read, exported for its tests.
 *
 * Exported under a name of its own rather than widened on the public surface: the
 * only caller is `checkAccountsQuota`, and tests that reach through it cannot
 * observe which hosts were asked or with what project, which is the part that
 * decides whether the weekly allowance is read at all.
 */
export const checkAccountQuotaForTest = checkAccountQuota;
//# sourceMappingURL=quota.js.map