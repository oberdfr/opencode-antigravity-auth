import { type AccountStorageV4, type AccountMetadataV3, type RateLimitStateV3, type ModelFamily, type HeaderStyle, type CooldownReason } from "./storage";
import type { OAuthAuthDetails, RefreshParts } from "./types";
import type { AccountSelectionStrategy } from "./config/schema";
import { type Fingerprint, type FingerprintVersion } from "./fingerprint";
import type { QuotaGroup, QuotaGroupSummary } from "./quota";
import { type AccountSelection, type AccountTier } from "./selection";
export type { ModelFamily, HeaderStyle, CooldownReason } from "./storage";
export type { AccountSelectionStrategy } from "./config/schema";
export type RateLimitReason = "QUOTA_EXHAUSTED" | "RATE_LIMIT_EXCEEDED" | "MODEL_CAPACITY_EXHAUSTED" | "SERVER_ERROR" | "UNKNOWN";
export interface RateLimitBackoffResult {
    backoffMs: number;
    reason: RateLimitReason;
}
export declare function parseRateLimitReason(reason: string | undefined, message: string | undefined, status?: number): RateLimitReason;
export declare function calculateBackoffMs(reason: RateLimitReason, consecutiveFailures: number, retryAfterMs?: number | null): number;
export type BaseQuotaKey = "claude" | "gemini-antigravity" | "gemini-cli";
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`;
export interface ManagedAccount {
    index: number;
    email?: string;
    addedAt: number;
    lastUsed: number;
    parts: RefreshParts;
    access?: string;
    expires?: number;
    enabled: boolean;
    rateLimitResetTimes: RateLimitStateV3;
    lastSwitchReason?: "rate-limit" | "initial" | "rotation";
    coolingDownUntil?: number;
    cooldownReason?: CooldownReason;
    touchedForQuota: Record<string, number>;
    consecutiveFailures?: number;
    /** Timestamp of last failure for TTL-based reset of consecutiveFailures */
    lastFailureTime?: number;
    /** Per-account device fingerprint for rate limit mitigation */
    fingerprint?: import("./fingerprint").Fingerprint;
    /** History of previous fingerprints for this account */
    fingerprintHistory?: FingerprintVersion[];
    /** Cached quota data from last checkAccountsQuota() call */
    cachedQuota?: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
    cachedQuotaUpdatedAt?: number;
    /**
     * Whether this account is on a paid plan, once the plugin has read it.
     *
     * Read from the subscription the project context reports. Absent until then, and the
     * selection policy treats absent as paid so a paid account is never ranked below a
     * free one on the strength of a missing field.
     */
    tier?: AccountTier;
    verificationRequired?: boolean;
    verificationRequiredAt?: number;
    verificationRequiredReason?: string;
    verificationUrl?: string;
}
/**
 * Resolve the quota group for soft quota checks.
 *
 * When a model string is available, we can precisely determine the quota group.
 * When model is null/undefined, we fall back based on family:
 * - Claude → "claude" quota group
 * - Gemini → "gemini-pro" (conservative fallback; may misclassify flash models)
 *
 * @param family - The model family ("claude" | "gemini")
 * @param model - Optional model string for precise resolution
 * @returns The QuotaGroup to use for soft quota checks
 */
export declare function resolveQuotaGroup(family: ModelFamily, model?: string | null): QuotaGroup;
export declare function computeSoftQuotaCacheTtlMs(ttlConfig: "auto" | number, refreshIntervalMinutes: number): number;
/**
 * In-memory multi-account manager with sticky account selection.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per-model-family (claude/gemini) so an account
 * rate-limited for Claude can still be used for Gemini.
 *
 * Source of truth for the pool is `antigravity-accounts.json`.
 */
export declare class AccountManager {
    private accounts;
    private cursor;
    private currentAccountIndexByFamily;
    private sessionOffsetApplied;
    private lastToastAccountIndex;
    private lastToastTime;
    /**
     * Which accounts the user chose, or an empty pin for the whole pool.
     *
     * Held here rather than passed into each selection call because it is a property of
     * the pool, not of one request: every caller wants the same answer, and threading it
     * through each call site is how a path ends up quietly ignoring it.
     */
    private selection;
    private savePending;
    private saveTimeout;
    private savePromiseResolvers;
    static loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager>;
    constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageV4 | null);
    getAccountCount(): number;
    getTotalAccountCount(): number;
    getEnabledAccounts(): ManagedAccount[];
    getAccountsSnapshot(): ManagedAccount[];
    getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null;
    markSwitched(account: ManagedAccount, reason: "rate-limit" | "initial" | "rotation", family: ModelFamily): void;
    /**
     * Check if we should show an account switch toast.
     * Debounces repeated toasts for the same account.
     */
    shouldShowAccountToast(accountIndex: number, debounceMs?: number): boolean;
    markToastShown(accountIndex: number): void;
    getCurrentOrNextForFamily(family: ModelFamily, model?: string | null, strategy?: AccountSelectionStrategy, headerStyle?: HeaderStyle, pidOffsetEnabled?: boolean, softQuotaThresholdPercent?: number, softQuotaCacheTtlMs?: number): ManagedAccount | null;
    getNextForFamily(family: ModelFamily, model?: string | null, headerStyle?: HeaderStyle, softQuotaThresholdPercent?: number, softQuotaCacheTtlMs?: number): ManagedAccount | null;
    markRateLimited(account: ManagedAccount, retryAfterMs: number, family: ModelFamily, headerStyle?: HeaderStyle, model?: string | null): void;
    /**
     * Mark an account as used after a successful API request.
     * This updates the lastUsed timestamp for freshness calculations.
     * Should be called AFTER request completion, not during account selection.
     */
    markAccountUsed(accountIndex: number): void;
    /** The accounts the user chose, or an empty pin for the whole pool. */
    getSelection(): AccountSelection;
    /** Whether the pool is currently narrowed to specific accounts. */
    hasSelection(): boolean;
    /**
     * Narrows the pool to the given accounts, or widens it back to all of them.
     *
     * Emails that are not in the pool are dropped rather than stored, so a selection
     * naming a removed account does not leave a permanent hole in the pool that reads as
     * "this account is excluded" with no way to tell it from a typo.
     *
     * Also resets the per-family cursors: they point into the old ordering, and leaving
     * them would make the first request after a change land on an arbitrary account
     * rather than the one the new selection puts first.
     */
    setSelection(pinnedEmails: string[]): Promise<AccountSelection>;
    /**
     * Widens the pool back to every account.
     *
     * Called when the pin has nothing usable left and the user has been told. The pin is
     * not restored afterwards on purpose: leaving it in force would make the very next
     * request widen itself again and re-send the same warning, once per request, for as
     * long as the condition held. The widening is persisted so it survives the restart
     * that a wedged session usually ends in.
     */
    clearSelection(): Promise<AccountSelection>;
    /**
     * Describes a pin that has no usable account left, for the message shown before the
     * request moves past it. Undefined when nothing is pinned or when the pool outside
     * the pin is empty, because in both cases there is nothing to switch to.
     */
    describeSelectionExhaustion(): import("./selection").ExhaustionReport | undefined;
    /** The pool as the selection policy sees it, for callers that render or report it. */
    getSelectableAccounts(): ManagedAccount[];
    private persistSelection;
    markRateLimitedWithReason(account: ManagedAccount, family: ModelFamily, headerStyle: HeaderStyle, model: string | null | undefined, reason: RateLimitReason, retryAfterMs?: number | null, failureTtlMs?: number): number;
    markRequestSuccess(account: ManagedAccount): void;
    clearAllRateLimitsForFamily(family: ModelFamily, model?: string | null): void;
    shouldTryOptimisticReset(family: ModelFamily, model?: string | null): boolean;
    markAccountCoolingDown(account: ManagedAccount, cooldownMs: number, reason: CooldownReason): void;
    isAccountCoolingDown(account: ManagedAccount): boolean;
    clearAccountCooldown(account: ManagedAccount): void;
    getAccountCooldownReason(account: ManagedAccount): CooldownReason | undefined;
    markTouchedForQuota(account: ManagedAccount, quotaKey: string): void;
    isFreshForQuota(account: ManagedAccount, quotaKey: string): boolean;
    getFreshAccountsForQuota(quotaKey: string, family: ModelFamily, model?: string | null): ManagedAccount[];
    isRateLimitedForHeaderStyle(account: ManagedAccount, family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): boolean;
    getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily, model?: string | null): HeaderStyle | null;
    /**
     * Check if any OTHER account has antigravity quota available for the given family/model.
     *
     * Used to determine whether to switch accounts vs fall back to gemini-cli:
     * - If true: Switch to another account (preserve antigravity priority)
     * - If false: All accounts exhausted antigravity, safe to fall back to gemini-cli
     *
     * @param currentAccountIndex - Index of the current account (will be excluded from check)
     * @param family - Model family ("gemini" or "claude")
     * @param model - Optional model name for model-specific rate limits
     * @returns true if any other enabled, non-cooling-down account has antigravity available
     */
    hasOtherAccountWithAntigravityAvailable(currentAccountIndex: number, family: ModelFamily, model?: string | null): boolean;
    setAccountEnabled(accountIndex: number, enabled: boolean): boolean;
    markAccountVerificationRequired(accountIndex: number, reason?: string, verifyUrl?: string): boolean;
    clearAccountVerificationRequired(accountIndex: number, enableAccount?: boolean): boolean;
    removeAccountByIndex(accountIndex: number): boolean;
    removeAccount(account: ManagedAccount): boolean;
    updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void;
    toAuthDetails(account: ManagedAccount): OAuthAuthDetails;
    getMinWaitTimeForFamily(family: ModelFamily, model?: string | null, headerStyle?: HeaderStyle, strict?: boolean): number;
    getAccounts(): ManagedAccount[];
    saveToDisk(): Promise<void>;
    /**
     * The pool as it is on disk, rebuilt from this manager's state.
     *
     * One place builds it so the account fields and the selection cannot drift apart: the
     * selection is written from the manager that owns it rather than left to whichever
     * writer happened to touch the file last.
     */
    private toStorage;
    requestSaveToDisk(): void;
    flushSaveToDisk(): Promise<void>;
    private executeSave;
    /**
     * Regenerate fingerprint for an account, saving the old one to history.
     * @param accountIndex - Index of the account to regenerate fingerprint for
     * @returns The new fingerprint, or null if account not found
     */
    regenerateAccountFingerprint(accountIndex: number): Fingerprint | null;
    /**
     * Restore a fingerprint from history for an account.
     * @param accountIndex - Index of the account
     * @param historyIndex - Index in the fingerprint history to restore from (0 = most recent)
     * @returns The restored fingerprint, or null if account/history not found
     */
    restoreAccountFingerprint(accountIndex: number, historyIndex: number): Fingerprint | null;
    /**
     * Get fingerprint history for an account.
     * @param accountIndex - Index of the account
     * @returns Array of fingerprint versions, or empty array if not found
     */
    getAccountFingerprintHistory(accountIndex: number): FingerprintVersion[];
    updateQuotaCache(accountIndex: number, quotaGroups: Partial<Record<QuotaGroup, QuotaGroupSummary>>): void;
    isAccountOverSoftQuota(account: ManagedAccount, family: ModelFamily, thresholdPercent: number, cacheTtlMs: number, model?: string | null): boolean;
    getAccountsForQuotaCheck(): AccountMetadataV3[];
    getOldestQuotaCacheAge(): number | null;
    areAllAccountsOverSoftQuota(family: ModelFamily, thresholdPercent: number, cacheTtlMs: number, model?: string | null): boolean;
    /**
     * Get minimum wait time until any account's soft quota resets.
     * Returns 0 if any account is available (not over threshold).
     * Returns the minimum resetTime across all over-threshold accounts.
     * Returns null if no resetTime data is available.
     */
    getMinWaitTimeForSoftQuota(family: ModelFamily, thresholdPercent: number, cacheTtlMs: number, model?: string | null): number | null;
}
//# sourceMappingURL=accounts.d.ts.map