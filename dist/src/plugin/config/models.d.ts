import type { ProviderModel } from "../types";
export type ModelThinkingLevel = "minimal" | "low" | "medium" | "high";
export interface ModelThinkingConfig {
    thinkingBudget?: number;
    /**
     * Gemini 3 level-based thinking.
     *
     * Mutually exclusive with thinkingBudget: the gateway takes one or the other, and
     * sending both leaves the choice to it.
     */
    thinkingLevel?: ModelThinkingLevel;
    /**
     * Whether the model returns its reasoning alongside the answer.
     *
     * A level on its own does not do this. The level says how much to think and this
     * says whether any of it reaches the client, so a config carrying only the level
     * spends the effort and shows nothing for it.
     */
    includeThoughts?: boolean;
}
export interface ModelVariant {
    thinkingLevel?: ModelThinkingLevel;
    thinkingConfig?: ModelThinkingConfig;
}
export interface ModelLimit {
    context: number;
    output: number;
}
export type ModelModality = "text" | "image" | "pdf";
export interface ModelModalities {
    input: ModelModality[];
    output: ModelModality[];
}
export interface OpencodeModelDefinition extends ProviderModel {
    name: string;
    limit: ModelLimit;
    modalities: ModelModalities;
    variants?: Record<string, ModelVariant>;
}
export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>;
export declare const OPENCODE_MODEL_DEFINITIONS: OpencodeModelDefinitions;
//# sourceMappingURL=models.d.ts.map