import type { OAuthAuthDetails, ProjectContextResult } from "./types";
interface AntigravityUserTier {
    id?: string;
    isDefault?: boolean;
    userDefinedCloudaicompanionProject?: boolean;
}
interface LoadCodeAssistPayload {
    cloudaicompanionProject?: string | {
        id?: string;
    };
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
export declare function invalidateProjectContextCache(refresh?: string): void;
/**
 * Discards every remembered project on disk.
 *
 * Not wired to token refresh; this is for a deliberate reset, such as after
 * reprovisioning an account.
 */
export declare function clearPersistedProjectContext(): Promise<void>;
/**
 * Loads managed project information for the given access token and optional project.
 */
export declare function loadManagedProject(accessToken: string, projectId?: string): Promise<LoadCodeAssistPayload | null>;
/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export declare function onboardManagedProject(accessToken: string, tierId: string, projectId?: string, attempts?: number, delayMs?: number): Promise<string | undefined>;
/**
 * Resolves an effective project ID for the current auth state, caching results per refresh token.
 */
export declare function ensureProjectContext(auth: OAuthAuthDetails): Promise<ProjectContextResult>;
export {};
//# sourceMappingURL=project.d.ts.map