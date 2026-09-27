/**
 * OpenCode configuration file updater.
 *
 * Updates ~/.config/opencode/opencode.json(c) with plugin models.
 */
export interface UpdateConfigResult {
    success: boolean;
    configPath: string;
    error?: string;
}
export interface OpencodeConfig {
    $schema?: string;
    plugins?: PluginConfigEntry[];
    plugin?: string[];
    providers?: Record<string, unknown>;
    provider?: {
        google?: {
            models?: Record<string, unknown>;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
type PluginConfigEntry = string | {
    package: string;
    options?: Record<string, unknown>;
};
export interface UpdateConfigOptions {
    /** Override the config file path (for testing) */
    configPath?: string;
    /** Select a syntax explicitly; auto-detect preserves an existing config's API generation. */
    format?: "auto" | "v1" | "v2";
}
/**
 * Get the opencode config directory path.
 */
export declare function getOpencodeConfigDir(): string;
/**
 * Get the opencode config file path.
 *
 * Prefers opencode.jsonc when present so we update the active config file
 * instead of creating a new opencode.json.
 */
export declare function getOpencodeConfigPath(): string;
/**
 * Updates the opencode configuration file with plugin models.
 *
 * This function:
 * 1. Reads existing opencode.json/opencode.jsonc (or creates default structure)
 * 2. Adds model definitions for V1 configs, where models must be declared
 *    manually. V2 registers models through the plugin API.
 * 3. Writes back to disk with proper formatting
 *
 * Preserves:
 * - $schema and other top-level config keys
 * - Non-google provider sections
 * - Other settings within google provider (except models)
 *
 * @param options - Optional configuration (e.g., custom configPath for testing)
 * @returns UpdateConfigResult with success status and path
 */
export declare function updateOpencodeConfig(options?: UpdateConfigOptions): Promise<UpdateConfigResult>;
export {};
//# sourceMappingURL=updater.d.ts.map