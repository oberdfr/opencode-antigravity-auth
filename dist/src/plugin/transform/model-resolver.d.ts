/**
 * Model Resolution with Thinking Tier Support
 *
 * Resolves model names with tier suffixes (e.g., gemini-3-pro-high, claude-opus-4-6-thinking-low)
 * to their actual API model names and corresponding thinking configurations.
 */
import type { ResolvedModel, ThinkingTier, GoogleSearchConfig } from "./types";
export interface ModelResolverOptions {
    cli_first?: boolean;
    /**
     * Thinking level the request asked for, when it is not carried by the model name.
     *
     * The catalog exposes one model per family and the level arrives as a variant that
     * patches the body, so the model id alone cannot say which level was chosen. Without
     * this the tiered Flash branch would fall back to its default and every level would
     * resolve to the same wire model.
     */
    thinkingLevel?: ThinkingTier;
}
/**
 * Thinking tier budgets by model family.
 * Claude and Gemini 2.5 Pro use numeric budgets.
 */
export declare const THINKING_TIER_BUDGETS: {
    readonly claude: {
        readonly low: 8192;
        readonly medium: 16384;
        readonly high: 32768;
    };
    readonly "gemini-2.5-pro": {
        readonly low: 8192;
        readonly medium: 16384;
        readonly high: 32768;
    };
    readonly "gemini-2.5-flash": {
        readonly low: 6144;
        readonly medium: 12288;
        readonly high: 24576;
    };
    readonly default: {
        readonly low: 4096;
        readonly medium: 8192;
        readonly high: 16384;
    };
};
/**
 * Gemini 3 uses thinkingLevel strings instead of numeric budgets.
 * Flash supports: minimal, low, medium, high
 * Pro supports: low, high (no minimal/medium)
 */
export declare const GEMINI_3_THINKING_LEVELS: readonly ["minimal", "low", "medium", "high"];
/**
 * Model aliases - maps user-friendly names to API model names.
 *
 * Format:
 * - Gemini 3 Pro variants: gemini-3-pro-{low,medium,high}
 * - Claude thinking variants: claude-{model}-thinking-{low,medium,high}
 * - Claude non-thinking: claude-{model} (no -thinking suffix)
 */
export declare const MODEL_ALIASES: Record<string, string>;
/**
 * Points a retired id at the model that serves it, keeping any tier suffix.
 *
 * Returns the id unchanged when it is not one of the retired ones.
 */
export declare function applyModelRedirect(model: string): string;
export declare function isTieredFlashModel(model: string): boolean;
export declare function resolveModelWithTier(requestedModel: string, options?: ModelResolverOptions): ResolvedModel;
/**
 * Gets the model family for routing decisions.
 */
export declare function getModelFamily(model: string): "claude" | "gemini-flash" | "gemini-pro";
/**
 * Variant config from OpenCode's providerOptions.
 */
export interface VariantConfig {
    thinkingBudget?: number;
    googleSearch?: GoogleSearchConfig;
}
/**
 * Resolves model name for a specific headerStyle (quota fallback support).
 * Transforms model names when switching between gemini-cli and antigravity quotas.
 *
 * Issue #103: When quota fallback occurs, model names need to be transformed:
 * - gemini-3-flash-preview (gemini-cli) → gemini-3-flash (antigravity)
 * - gemini-3-pro-preview (gemini-cli) → gemini-3-pro-low (antigravity)
 * - gemini-3-flash (antigravity) → gemini-3-flash-preview (gemini-cli)
 */
export declare function resolveModelForHeaderStyle(requestedModel: string, headerStyle: "antigravity" | "gemini-cli", options?: ModelResolverOptions): ResolvedModel;
/**
 * Resolves model with variant config from providerOptions.
 * Variant config takes priority over tier suffix in model name.
 */
export declare function resolveModelWithVariant(requestedModel: string, variantConfig?: VariantConfig): ResolvedModel;
//# sourceMappingURL=model-resolver.d.ts.map