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
export const THINKING_TIER_BUDGETS = {
  claude: { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-pro": { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-flash": { low: 6144, medium: 12288, high: 24576 },
  default: { low: 4096, medium: 8192, high: 16384 },
} as const;

/**
 * Gemini 3 uses thinkingLevel strings instead of numeric budgets.
 * Flash supports: minimal, low, medium, high
 * Pro supports: low, high (no minimal/medium)
 */
export const GEMINI_3_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;

/**
 * Model aliases - maps user-friendly names to API model names.
 * 
 * Format:
 * - Gemini 3 Pro variants: gemini-3-pro-{low,medium,high}
 * - Claude thinking variants: claude-{model}-thinking-{low,medium,high}
 * - Claude non-thinking: claude-{model} (no -thinking suffix)
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Gemini 3 variants - for Gemini CLI only (tier stripped, thinkingLevel used)
  // For Antigravity, these are bypassed and full model name is kept
  "gemini-3-pro-low": "gemini-3-pro",
  "gemini-3-pro-high": "gemini-3-pro",
  "gemini-3.1-pro-low": "gemini-3.1-pro",
  "gemini-3.1-pro-high": "gemini-3.1-pro",
  "gemini-3-flash-low": "gemini-3-flash",
  "gemini-3-flash-medium": "gemini-3-flash",
  "gemini-3-flash-high": "gemini-3-flash",

  // Claude proxy names (gemini- prefix for compatibility)
  "gemini-claude-opus-4-6-thinking-low": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-medium": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-high": "claude-opus-4-6-thinking",
  "gemini-claude-sonnet-4-6": "claude-sonnet-4-6",

  // Image generation models - only gemini-3-pro-image is available via Antigravity API
  // Note: gemini-2.5-flash-image (Nano Banana) is NOT supported by Antigravity - only Google AI API
  // Reference: Antigravity-Manager/src-tauri/src/proxy/common/model_mapping.rs
};

const TIER_REGEX = /-(minimal|low|medium|high)$/;
const QUOTA_PREFIX_REGEX = /^antigravity-/i;
const GEMINI_3_PRO_REGEX = /^gemini-3(?:\.\d+)?-pro/i;
const GEMINI_3_FLASH_REGEX = /^gemini-3(?:\.\d+)?-flash/i;
/**
 * Gemini 3.6/3.7/3.8 Flash on Antigravity: the gateway accepts only the
 * `-tiered` catalog name plus generationConfig.thinkingConfig.thinkingLevel.
 * Sending `gemini-3.7-flash-medium` returns 404. See 9router commit 86694ed.
 */
const TIERED_FLASH_REGEX = /^gemini-3\.(6|7|8)-flash(-tiered)?$/i;

/**
 * Retired model ids, and what serves the request instead.
 *
 * Antigravity withdrew Gemini 3 Pro and answers a request for it with
 * "Gemini 3 Pro is no longer available. Please switch to Gemini 3.1 Pro" — as a 200
 * whose body is that sentence, so the client has no error to notice and shows the notice
 * as if it were the answer.
 *
 * The entry stays in the catalog because removing it is a worse outcome than serving it:
 * a model that has quietly stopped working is easier to miss than one that is gone from
 * the picker. So the request is pointed at the replacement, which keeps the name people
 * have in their config working and keeps the thinking tiers meaningful.
 *
 * Keyed on the id without its tier, because the tier travels in the name for the pro
 * family and has to survive the substitution.
 */
const RETIRED_MODELS: Record<string, string> = {
  "gemini-3-pro": "gemini-3.1-pro",
  // The Gemini CLI route reaches the same withdrawn model under its preview name, so it
  // needs covering too. Leaving one route on the retired id and the other on the
  // replacement would make the split look like a quota problem rather than a model
  // that is simply gone.
  "gemini-3-pro-preview": "gemini-3.1-pro-preview",
};

/**
 * Points a retired id at the model that serves it, keeping any tier suffix.
 *
 * Returns the id unchanged when it is not one of the retired ones.
 */
export function applyModelRedirect(model: string): string {
  const match = /^(.*?)-(minimal|low|medium|high)$/.exec(model);
  const base = (match?.[1] ?? model).toLowerCase();
  const tier = match?.[2] ? `-${match[2]}` : "";

  const replacement = RETIRED_MODELS[base];
  return replacement ? `${replacement}${tier}` : model;
}

export function isTieredFlashModel(model: string): boolean {
  return TIERED_FLASH_REGEX.test(model);
}

const TIERED_FLASH_DEFAULT_LEVEL = "medium";

// ANTIGRAVITY_ONLY_MODELS removed - all models now default to antigravity

/**
 * Image generation models - always route to Antigravity.
 * These models don't support thinking and require imageConfig.
 */
const IMAGE_GENERATION_MODELS = /image|imagen/i;

// Legacy LEGACY_ANTIGRAVITY_GEMINI3 regex removed - all Gemini models now default to antigravity

/**
 * Models that support thinking tier suffixes.
 * Only these models should have -low/-medium/-high stripped as thinking tiers.
 * GPT models like gpt-oss-120b-medium should NOT have -medium stripped.
 */
function supportsThinkingTiers(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("gemini-3") ||
    lower.includes("gemini-2.5") ||
    (lower.includes("claude") && lower.includes("thinking"))
  );
}

/**
 * Extracts thinking tier from model name suffix.
 * Only extracts tier for models that support thinking tiers.
 */
function extractThinkingTierFromModel(model: string): ThinkingTier | undefined {
  // Only extract tier for models that support thinking tiers
  if (!supportsThinkingTiers(model)) {
    return undefined;
  }
  const tierMatch = model.match(TIER_REGEX);
  return tierMatch?.[1] as ThinkingTier | undefined;
}

/**
 * Determines the budget family for a model.
 */
function getBudgetFamily(model: string): keyof typeof THINKING_TIER_BUDGETS {
  if (model.includes("claude")) {
    return "claude";
  }
  if (model.includes("gemini-2.5-pro")) {
    return "gemini-2.5-pro";
  }
  if (model.includes("gemini-2.5-flash")) {
    return "gemini-2.5-flash";
  }
  return "default";
}

/**
 * Checks if a model is a thinking-capable model.
 */
function isThinkingCapableModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("thinking") ||
    lower.includes("gemini-3") ||
    lower.includes("gemini-2.5")
  );
}

function isGemini3ProModel(model: string): boolean {
  return GEMINI_3_PRO_REGEX.test(model);
}

function isGemini3FlashModel(model: string): boolean {
  return GEMINI_3_FLASH_REGEX.test(model);
}

/**
 * Resolves a model name with optional tier suffix and quota prefix to its actual API model name
 * and corresponding thinking configuration.
 *
 * Quota routing:
 * - Default to Antigravity quota unless cli_first is enabled for Gemini models
 * - Fallback to Gemini CLI happens at account rotation level when Antigravity is exhausted
 * - "antigravity-" prefix marks explicit quota (no fallback allowed)
 * - Claude and image models always use Antigravity
 *
 * Examples:
 * - "gemini-2.5-flash" → { quotaPreference: "antigravity" }
 * - "gemini-3-pro-preview" → { quotaPreference: "antigravity" }
 * - "antigravity-gemini-3-pro-high" → { quotaPreference: "antigravity", explicitQuota: true }
 * - "claude-opus-4-6-thinking-medium" → { quotaPreference: "antigravity" }
 *
 * @param requestedModel - The model name from the request
 * @param options - Optional configuration including cli_first preference
 * @returns Resolved model with thinking configuration
 */
/**
 * The level to put in a per-tier Flash sku name, or undefined when there is not one.
 *
 * The sku names the level, so only the levels that have a sku can be returned. minimal is
 * served by the low sku.
 */
function resolveFlashSkuLevel(level: ThinkingTier | undefined): "low" | "medium" | "high" | undefined {
  if (level === "low" || level === "medium" || level === "high") return level;
  if (level === "minimal") return "low";
  return undefined;
}

export function resolveModelWithTier(requestedModel: string, options: ModelResolverOptions = {}): ResolvedModel {  const isAntigravity = QUOTA_PREFIX_REGEX.test(requestedModel);
  const modelWithoutQuota = requestedModel.replace(QUOTA_PREFIX_REGEX, "");

  const tier = extractThinkingTierFromModel(modelWithoutQuota);
  const baseName = tier ? modelWithoutQuota.replace(TIER_REGEX, "") : modelWithoutQuota;

  const isImageModel = IMAGE_GENERATION_MODELS.test(modelWithoutQuota);
  const isClaudeModel = modelWithoutQuota.toLowerCase().includes("claude");
  
  // All models default to Antigravity quota unless cli_first is enabled
  // Fallback to gemini-cli happens at the account rotation level when Antigravity is exhausted
  const preferGeminiCli = options.cli_first === true && !isAntigravity && !isImageModel && !isClaudeModel;
  const quotaPreference = preferGeminiCli ? "gemini-cli" as const : "antigravity" as const;
  const explicitQuota = isAntigravity || isImageModel;

  const isGemini3 = modelWithoutQuota.toLowerCase().startsWith("gemini-3");
  const skipAlias = isAntigravity && isGemini3;

  // 3.6/3.7/3.8 Flash: always resolve to -tiered + thinkingLevel.
  // Do this before skipAlias so antigravity-gemini-3.7-flash-medium works too.
  //
  // The per-tier skus (flash-low/medium/high) are what the IDE client asks for, and they
  // are served only from the production hosts — which these accounts are not licensed
  // for. On the sandbox hosts they come back 404, so the tiered name is what the level
  // travels on here. The level still comes from the request rather than from the model
  // name, because the catalog carries one model per family.
  if (isTieredFlashModel(baseName) && quotaPreference === "antigravity" && !isImageModel) {
    const flashBase = baseName.replace(/-tiered$/i, "");
    const level = resolveFlashSkuLevel(tier) ?? resolveFlashSkuLevel(options.thinkingLevel) ?? TIERED_FLASH_DEFAULT_LEVEL;
    return {
      actualModel: `${flashBase}-tiered`,
      thinkingLevel: level,
      tier: level,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  // For Antigravity Gemini 3 Pro models without explicit tier, append default tier
  // Antigravity API: gemini-3-pro requires tier suffix (gemini-3-pro-low/high)
  //                  gemini-3-flash uses bare name + thinkingLevel param
  // Pro defaults to -low unless an explicit tier is provided
  const isGemini3Pro = isGemini3ProModel(modelWithoutQuota);
  const isGemini3Flash = isGemini3FlashModel(modelWithoutQuota);
  
  let antigravityModel = modelWithoutQuota;
  if (skipAlias) {
    if (isGemini3Pro && !tier && !isImageModel) {
      antigravityModel = `${modelWithoutQuota}-low`;
    } else if (isGemini3Flash && tier) {
      antigravityModel = baseName;
    }
  }

  const actualModel = skipAlias
    ? antigravityModel
    : MODEL_ALIASES[modelWithoutQuota] || MODEL_ALIASES[baseName] || baseName;

  // Point a withdrawn id at the model that serves it, after the tier has been applied,
  // so the tier the caller asked for survives the substitution.
  const resolvedModel = applyModelRedirect(actualModel);

  const isThinking = isThinkingCapableModel(resolvedModel);

  // Image generation models don't support thinking - return early without thinking config
  if (isImageModel) {
    return {
      actualModel: resolvedModel,
      isThinkingModel: false,
      isImageModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  // Check if this is a Gemini 3 model (works for both aliased and skipAlias paths)
  const isEffectiveGemini3 = resolvedModel.toLowerCase().includes("gemini-3");
  const isClaudeThinking = resolvedModel.toLowerCase().includes("claude") && resolvedModel.toLowerCase().includes("thinking");

  if (!tier) {
    // Gemini 3 models without explicit tier get a default thinkingLevel
    if (isEffectiveGemini3) {
      return {
        actualModel: resolvedModel,
        thinkingLevel: "low",
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }
    // Claude thinking models without explicit tier get max budget (32768)
    // Per Anthropic docs, budget_tokens is required when enabling extended thinking
    if (isClaudeThinking) {
      return {
        actualModel: resolvedModel,
        thinkingBudget: THINKING_TIER_BUDGETS.claude.high,
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }
    return { actualModel: resolvedModel, isThinkingModel: isThinking, quotaPreference, explicitQuota };
  }

  // Gemini 3 models with tier always get thinkingLevel set
  if (isEffectiveGemini3) {
    return {
      actualModel: resolvedModel,
      thinkingLevel: tier,
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  const budgetFamily = getBudgetFamily(resolvedModel);
  const budgets = THINKING_TIER_BUDGETS[budgetFamily];
  // The budget tables predate the minimal tier and have no row for it. Minimal is the
  // smallest effort there is, so it is answered from the low row rather than left
  // undefined and turned into no thinking at all.
  const budgetTier = tier === "minimal" ? "low" : tier;
  const thinkingBudget = budgetTier ? budgets[budgetTier] : undefined;

  return {
    actualModel: resolvedModel,
    thinkingBudget,
    tier,
    isThinkingModel: isThinking,
    quotaPreference,
    explicitQuota,
  };
}

/**
 * Gets the model family for routing decisions.
 */
export function getModelFamily(model: string): "claude" | "gemini-flash" | "gemini-pro" {
  const lower = model.toLowerCase();
  if (lower.includes("claude")) {
    return "claude";
  }
  if (lower.includes("flash")) {
    return "gemini-flash";
  }
  return "gemini-pro";
}

/**
 * Variant config from OpenCode's providerOptions.
 */
export interface VariantConfig {
  thinkingBudget?: number;
  googleSearch?: GoogleSearchConfig;
}

/**
 * Maps a thinking budget to Gemini 3 thinking level.
 * ≤8192 → low, ≤16384 → medium, >16384 → high
 */
function budgetToGemini3Level(budget: number): "low" | "medium" | "high" {
  if (budget <= 8192) return "low";
  if (budget <= 16384) return "medium";
  return "high";
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
export function resolveModelForHeaderStyle(
  requestedModel: string,
  headerStyle: "antigravity" | "gemini-cli",
  options: ModelResolverOptions = {}
): ResolvedModel {
  const lower = requestedModel.toLowerCase();
  const isGemini3 = lower.includes("gemini-3");
  
  if (!isGemini3) {
    return resolveModelWithTier(requestedModel, options);
  }

  if (headerStyle === "antigravity") {
    let transformedModel = requestedModel
      .replace(/-preview-customtools$/i, "")
      .replace(/-preview$/i, "")
      .replace(/^antigravity-/i, "");
    
    const isGemini3Pro = isGemini3ProModel(transformedModel);
    const hasTierSuffix = /-(low|medium|high)$/i.test(transformedModel);
    const isImageModel = IMAGE_GENERATION_MODELS.test(transformedModel);
    
    // Don't add tier suffix to image models - they don't support thinking
    if (isGemini3Pro && !hasTierSuffix && !isImageModel) {
      transformedModel = `${transformedModel}-low`;
    }
    
    const prefixedModel = `antigravity-${transformedModel}`;
    return resolveModelWithTier(prefixedModel, options);
  }
  
  if (headerStyle === "gemini-cli") {
    let transformedModel = requestedModel
      .replace(/^antigravity-/i, "")
      .replace(/-(low|medium|high)$/i, "");

    const hasPreviewSuffix = /-preview($|-)/i.test(transformedModel);
    if (!hasPreviewSuffix) {
      transformedModel = `${transformedModel}-preview`;
    }
    
    return {
      ...resolveModelWithTier(transformedModel, options),
      quotaPreference: "gemini-cli",
    };
  }

  return resolveModelWithTier(requestedModel, options);
}

/**
 * Resolves model with variant config from providerOptions.
 * Variant config takes priority over tier suffix in model name.
 */
export function resolveModelWithVariant(
  requestedModel: string,
  variantConfig?: VariantConfig
): ResolvedModel {
  const base = resolveModelWithTier(requestedModel);

  if (!variantConfig) {
    return base;
  }

  // Apply Google Search config if present
  if (variantConfig.googleSearch) {
    base.googleSearch = variantConfig.googleSearch;
    base.configSource = "variant";
  }

  if (!variantConfig.thinkingBudget) {
    return base;
  }

  const budget = variantConfig.thinkingBudget;
  const isGemini3 = base.actualModel.toLowerCase().includes("gemini-3");

  if (isGemini3) {
    const level = budgetToGemini3Level(budget);
    const isAntigravityGemini3Pro = base.quotaPreference === "antigravity" &&
      isGemini3ProModel(base.actualModel);

    let actualModel = base.actualModel;
    if (isAntigravityGemini3Pro) {
      const baseModel = base.actualModel.replace(/-(low|medium|high)$/, "");
      actualModel = `${baseModel}-${level}`;
    }

    return {
      ...base,
      actualModel,
      thinkingLevel: level,
      thinkingBudget: undefined,
      configSource: "variant",
    };
  }

  return {
    ...base,
    thinkingBudget: budget,
    configSource: "variant",
  };
}
