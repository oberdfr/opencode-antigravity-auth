/**
 * OpenCode configuration file updater.
 *
 * Updates ~/.config/opencode/opencode.json(c) with plugin models.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { OPENCODE_MODEL_DEFINITIONS } from "./models";

// =============================================================================
// Types
// =============================================================================

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

type PluginConfigEntry = string | { package: string; options?: Record<string, unknown> };

export interface UpdateConfigOptions {
  /** Override the config file path (for testing) */
  configPath?: string;
  /** Select a syntax explicitly; auto-detect preserves an existing config's API generation. */
  format?: "auto" | "v1" | "v2";
}

// =============================================================================
// Constants
// =============================================================================

const PLUGIN_NAME = "opencode-antigravity-auth@latest";
const SCHEMA_URL = "https://opencode.ai/config.json";
const OPENCODE_JSON_FILENAME = "opencode.json";
const OPENCODE_JSONC_FILENAME = "opencode.jsonc";

function stripJsonCommentsAndTrailingCommas(json: string): string {
  return json
    .replace(
      /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
      (match: string, group: string | undefined) => (group ? "" : match)
    )
    .replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Get the opencode config directory path.
 */
export function getOpencodeConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Get the opencode config file path.
 *
 * Prefers opencode.jsonc when present so we update the active config file
 * instead of creating a new opencode.json.
 */
export function getOpencodeConfigPath(): string {
  const configDir = getOpencodeConfigDir();
  const jsoncPath = join(configDir, OPENCODE_JSONC_FILENAME);
  const jsonPath = join(configDir, OPENCODE_JSON_FILENAME);

  if (existsSync(jsoncPath)) {
    return jsoncPath;
  }
  if (existsSync(jsonPath)) {
    return jsonPath;
  }

  return jsonPath;
}

// =============================================================================
// Main Function
// =============================================================================

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
export async function updateOpencodeConfig(
  options: UpdateConfigOptions = {}
): Promise<UpdateConfigResult> {
  const configPath = options.configPath ?? getOpencodeConfigPath();

  try {
    let config: OpencodeConfig;

    // Read existing config or create a native V2 structure.
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      config = JSON.parse(stripJsonCommentsAndTrailingCommas(content)) as OpencodeConfig;
    } else {
      // Create default config structure
      config = {
        $schema: SCHEMA_URL,
        ...(options.format === "v1" ? { plugin: [], provider: {} } : { plugins: [] }),
      };
    }

    // Ensure $schema is set
    if (!config.$schema) {
      config.$schema = SCHEMA_URL;
    }

    // Existing V1 configs keep their legacy provider/model declarations. New
    // and native V2 configs use `plugins`; V2 models are registered at runtime.
    const legacyConfig = options.format === "v1" || (
      options.format !== "v2" &&
      !Array.isArray(config.plugins) &&
      (Array.isArray(config.plugin) || config.provider !== undefined)
    );
    if (legacyConfig) {
      if (!Array.isArray(config.plugin)) config.plugin = [];
      if (!config.plugin.some((entry) => entry.includes("opencode-antigravity-auth"))) {
        config.plugin.push(PLUGIN_NAME);
      }

      if (!config.provider) config.provider = {};
      if (!config.provider.google) config.provider.google = {};
      config.provider.google.models = { ...OPENCODE_MODEL_DEFINITIONS };
    } else {
      if (!Array.isArray(config.plugins)) config.plugins = [];
      const hasPlugin = config.plugins.some((entry) => {
        const packageName = typeof entry === "string" ? entry : entry?.package;
        return packageName?.includes("opencode-antigravity-auth") ?? false;
      });
      if (!hasPlugin) config.plugins.push(PLUGIN_NAME);
    }

    // Ensure config directory exists
    const configDir = dirname(configPath);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // Write config with proper formatting (2-space indent)
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    return {
      success: true,
      configPath,
    };
  } catch (error) {
    return {
      success: false,
      configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
