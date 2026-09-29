import type { PluginClient } from "./types";
import type { AccountMetadataV3 } from "./storage";
export type QuotaGroup = "claude" | "gemini-pro" | "gemini-flash";
/**
 * One window of an allowance.
 *
 * A group can run on more than one: a subscription account has a five-hour
 * window and a weekly one, each refilling on its own schedule, so a group is
 * described by a list of windows rather than by a single figure. Free accounts
 * only ever have the weekly one, and end up with a list of one.
 */
export interface QuotaWindowSummary {
    remainingFraction?: number;
    resetTime?: string;
    /** How many of the group's models this window covers. */
    modelCount: number;
}
export interface QuotaGroupSummary {
    windows: QuotaWindowSummary[];
    modelCount: number;
}
export interface QuotaSummary {
    groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
    modelCount: number;
    error?: string;
}
export type AccountQuotaStatus = "ok" | "disabled" | "error";
export interface AccountQuotaResult {
    index: number;
    email?: string;
    status: AccountQuotaStatus;
    error?: string;
    disabled?: boolean;
    quota?: QuotaSummary;
    updatedAccount?: AccountMetadataV3;
    /** The account's plan, when project resolution reported one. */
    subscription?: {
        id: string;
        name?: string;
    };
}
export declare function checkAccountsQuota(accounts: AccountMetadataV3[], client: PluginClient, providerId?: string): Promise<AccountQuotaResult[]>;
declare function checkAccountQuota(account: AccountMetadataV3, index: number, client: PluginClient, providerId: string): Promise<AccountQuotaResult>;
/**
 * The per-account quota read, exported for its tests.
 *
 * Exported under a name of its own rather than widened on the public surface: the
 * only caller is `checkAccountsQuota`, and tests that reach through it cannot
 * observe which hosts were asked or with what project, which is the part that
 * decides whether the weekly allowance is read at all.
 */
export declare const checkAccountQuotaForTest: typeof checkAccountQuota;
export {};
//# sourceMappingURL=quota.d.ts.map