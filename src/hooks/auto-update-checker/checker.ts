import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { NpmDistTags, OpencodeConfig, PackageJson, UpdateCheckResult } from "./types";
import {
  PACKAGE_NAME,
  NPM_REGISTRY_URL,
  NPM_FETCH_TIMEOUT,
  INSTALLED_PACKAGE_JSON,
  USER_OPENCODE_CONFIG,
  USER_OPENCODE_CONFIG_JSONC,
} from "./constants";
import { logAutoUpdate } from "./logging";

export function isLocalDevMode(directory: string): boolean {
  return getLocalDevPath(directory) !== null;
}

function stripJsonComments(json: string): string {
  return json
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m: string, g: string | undefined) => (g ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");
}

function getConfigPaths(directory: string): string[] {
  return [
    path.join(directory, "opencode.json"),
    path.join(directory, "opencode.jsonc"),
    path.join(directory, ".opencode", "opencode.json"),
    path.join(directory, ".opencode", "opencode.jsonc"),
    path.join(directory, ".opencode.json"),
    USER_OPENCODE_CONFIG,
    USER_OPENCODE_CONFIG_JSONC,
  ];
}

function getPluginEntries(config: OpencodeConfig): string[] {
  const entries: string[] = [];
  for (const entry of [...(config.plugins ?? []), ...(config.plugin ?? [])]) {
    if (typeof entry === "string") entries.push(entry);
    else if (entry && typeof entry.package === "string") entries.push(entry.package);
  }
  return entries;
}

export function getLocalDevPath(directory: string): string | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const content = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig;
      for (const entry of getPluginEntries(config)) {
        if (entry.startsWith("file://") && entry.includes(PACKAGE_NAME)) {
          try {
            return fileURLToPath(entry);
          } catch {
            return entry.replace("file://", "");
          }
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

function findPackageJsonUp(startPath: string): string | null {
  try {
    const stat = fs.statSync(startPath);
    let dir = stat.isDirectory() ? startPath : path.dirname(startPath);

    for (let i = 0; i < 10; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const content = fs.readFileSync(pkgPath, "utf-8");
          const pkg = JSON.parse(content) as PackageJson;
          if (pkg.name === PACKAGE_NAME) return pkgPath;
        } catch {
          continue;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    return null;
  }
  return null;
}

export function getLocalDevVersion(directory: string): string | null {
  const localPath = getLocalDevPath(directory);
  if (!localPath) return null;

  try {
    const pkgPath = findPackageJsonUp(localPath);
    if (!pkgPath) return null;
    const content = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content) as PackageJson;
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export interface PluginEntryInfo {
  entry: string;
  isPinned: boolean;
  pinnedVersion: string | null;
  configPath: string;
}

export function findPluginEntry(directory: string): PluginEntryInfo | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const content = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig;
      for (const entry of getPluginEntries(config)) {
        if (entry === PACKAGE_NAME) {
          return { entry, isPinned: false, pinnedVersion: null, configPath };
        }
        if (entry.startsWith(`${PACKAGE_NAME}@`)) {
          const pinnedVersion = entry.slice(PACKAGE_NAME.length + 1);
          const isPinned = pinnedVersion !== "latest";
          return { entry, isPinned, pinnedVersion: isPinned ? pinnedVersion : null, configPath };
        }
        if (entry.startsWith("file://") && entry.includes(PACKAGE_NAME)) {
          return { entry, isPinned: false, pinnedVersion: null, configPath };
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function getCachedVersion(): string | null {
  try {
    if (fs.existsSync(INSTALLED_PACKAGE_JSON)) {
      const content = fs.readFileSync(INSTALLED_PACKAGE_JSON, "utf-8");
      const pkg = JSON.parse(content) as PackageJson;
      if (pkg.version) return pkg.version;
    }
  } catch {
    return null;
  }

  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = findPackageJsonUp(currentDir);
    if (pkgPath) {
      const content = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(content) as PackageJson;
      if (pkg.version) return pkg.version;
    }
  } catch (err) {
    logAutoUpdate(`Failed to resolve version from current directory: ${err}`);
  }

  return null;
}

export function updatePinnedVersion(configPath: string, oldEntry: string, newVersion: string): boolean {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const newEntry = `${PACKAGE_NAME}@${newVersion}`;

    const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig;
    const pluginKey = (["plugins", "plugin"] as const).find((key) =>
      getPluginEntries({ [key]: config[key] } as OpencodeConfig).includes(oldEntry),
    );
    if (!pluginKey) {
      logAutoUpdate(`Entry "${oldEntry}" not found in a plugin list of ${configPath}`);
      return false;
    }

    const escapedKey = pluginKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pluginMatch = content.match(new RegExp(`"${escapedKey}"\\s*:\\s*\\[`));
    if (!pluginMatch || pluginMatch.index === undefined) {
      logAutoUpdate(`No "${pluginKey}" array found in ${configPath}`);
      return false;
    }

    const startIdx = pluginMatch.index + pluginMatch[0].length;
    let bracketCount = 1;
    let endIdx = startIdx;
    let quote: string | undefined;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let i = startIdx; i < content.length && bracketCount > 0; i++) {
      const char = content[i];
      const next = content[i + 1];
      if (lineComment) {
        if (char === "\n") lineComment = false;
        endIdx = i;
        continue;
      }
      if (blockComment) {
        if (char === "*" && next === "/") {
          blockComment = false;
          i++;
        }
        endIdx = i;
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === "/" && next === "/") {
        lineComment = true;
        i++;
      } else if (char === "/" && next === "*") {
        blockComment = true;
        i++;
      } else if (char === "[") {
        bracketCount++;
      } else if (char === "]") {
        bracketCount--;
      }
      endIdx = i;
    }

    const before = content.slice(0, startIdx);
    const pluginArrayContent = content.slice(startIdx, endIdx);
    const after = content.slice(endIdx);

    const escapedOldEntry = oldEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`["']${escapedOldEntry}["']`);

    if (!regex.test(pluginArrayContent)) {
      logAutoUpdate(`Entry "${oldEntry}" not found in "${pluginKey}" array of ${configPath}`);
      return false;
    }

    const updatedPluginArray = pluginArrayContent.replace(regex, `"${newEntry}"`);
    const updatedContent = before + updatedPluginArray + after;

    if (updatedContent === content) {
      logAutoUpdate(`No changes made to ${configPath}`);
      return false;
    }

    fs.writeFileSync(configPath, updatedContent, "utf-8");
    logAutoUpdate(`Updated ${configPath}: ${oldEntry} → ${newEntry}`);
    return true;
  } catch (err) {
    console.error(`[auto-update-checker] Failed to update config file ${configPath}:`, err);
    return false;
  }
}

export async function getLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NPM_FETCH_TIMEOUT);

  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as NpmDistTags;
    return data.latest ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function checkForUpdate(directory: string): Promise<UpdateCheckResult> {
  if (isLocalDevMode(directory)) {
    logAutoUpdate("Local dev mode detected, skipping update check");
    return { needsUpdate: false, currentVersion: null, latestVersion: null, isLocalDev: true, isPinned: false };
  }

  const pluginInfo = findPluginEntry(directory);
  if (!pluginInfo) {
    logAutoUpdate("Plugin not found in config");
    return { needsUpdate: false, currentVersion: null, latestVersion: null, isLocalDev: false, isPinned: false };
  }

  const currentVersion = getCachedVersion() ?? pluginInfo.pinnedVersion;
  if (!currentVersion) {
    logAutoUpdate("No version found (cached or pinned)");
    return { needsUpdate: false, currentVersion: null, latestVersion: null, isLocalDev: false, isPinned: pluginInfo.isPinned };
  }

  const latestVersion = await getLatestVersion();
  if (!latestVersion) {
    logAutoUpdate("Failed to fetch latest version");
    return { needsUpdate: false, currentVersion, latestVersion: null, isLocalDev: false, isPinned: pluginInfo.isPinned };
  }

  const needsUpdate = currentVersion !== latestVersion;
  logAutoUpdate(`Current: ${currentVersion}, Latest: ${latestVersion}, NeedsUpdate: ${needsUpdate}`);
  return { needsUpdate, currentVersion, latestVersion, isLocalDev: false, isPinned: pluginInfo.isPinned };
}
