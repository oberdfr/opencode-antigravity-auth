/**
 * The Antigravity client version, as the gateway reads it.
 *
 * This is not the application's version. The header the gateway gates models on is
 * `antigravity/hub/<version>`, and the version in it is the hub's, published on the hub's
 * own update manifest. Conflating the two is not cosmetic: sending the application version
 * where the hub version belongs is answered with
 *
 *   403 "You do not have a valid license of this product ... please try using the latest
 *        version and logging in again" (#3501)
 *
 * which reads like a licensing problem and is not one. The model would be served to the
 * same account moments later with a header that names the version the gateway expects.
 *
 * Mirrors the reference implementation: the manifest is read once, a malformed or
 * unreachable manifest leaves the pinned fallback in place, and the whole thing is skipped
 * when a version is supplied.
 */

import { createLogger } from "./logger";

/**
 * The version of the reference client, and the offline fallback.
 *
 * Also the floor: nothing below this is served the newer models, so a discovered version
 * that parses but is older is ignored rather than sent.
 */
export const ANTIGRAVITY_HUB_VERSION_FALLBACK = "2.8.0";

/** Older than this and the gateway refuses the newer models. */
const ANTIGRAVITY_HUB_VERSION_FLOOR = "2.8.0";

/**
 * The hub's update manifest. A different service from the application's auto-updater, and
 * the only one that publishes the version the header needs.
 */
const HUB_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";

const HUB_MANIFEST_TIMEOUT_MS = 5_000;

/**
 * The changelist the real client sends. The gateway does not read it — stale, zero and
 * absent all pass — and the manifest carries none, so this is the captured value and is
 * left alone. It is a constant rather than a per-fingerprint random because a number that
 * means nothing to the gateway should not pretend to be an identity.
 */
const HUB_CLIENT_BUILD = "963137146";

/**
 * Platform and architecture of the reference client the version is captured from.
 *
 * Pinned rather than randomised: the manifest and the captured version come from that
 * client, and the gateway only reads the version. A fingerprint that varies these varies
 * nothing that is checked, while making two requests from one account look like two
 * machines.
 */
const HUB_OS = "darwin";
const HUB_ARCH = "arm64";

let hubVersion: string = ANTIGRAVITY_HUB_VERSION_FALLBACK;
let hubVersionFetch: Promise<void> | null = null;

const logger = () => createLogger("hub-version");

/** The hub version to send. */
export function getAntigravityHubVersion(): string {
  return hubVersion;
}

/**
 * Reads the version out of an electron-builder update manifest.
 * Returns null when no well-formed `version:` line is present.
 */
export function parseHubManifestVersion(yamlText: string): string | null {
  for (const line of yamlText.split(/\r?\n/)) {
    const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  }
  return null;
}

/** Whether a discovered version is new enough to be worth sending. */
export function isAtLeastHubVersionFloor(version: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(version), parse(ANTIGRAVITY_HUB_VERSION_FLOOR)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/**
 * Resolves the hub version from the manifest, once.
 *
 * A failure leaves the fallback in place and is not retried within the process, because
 * the fallback is a version the gateway serves and a retry would only add latency to the
 * first request of a session.
 */
export async function ensureAntigravityHubVersion(): Promise<void> {
  if (hubVersionFetch) return hubVersionFetch;

  hubVersionFetch = (async () => {
    try {
      const response = await fetch(HUB_MANIFEST_URL, {
        headers: { "Cache-Control": "no-cache", "User-Agent": "electron-builder" },
        signal: AbortSignal.timeout(HUB_MANIFEST_TIMEOUT_MS),
      });
      if (!response.ok) return;

      const discovered = parseHubManifestVersion(await response.text());
      // A manifest that parses but names something older than the floor is not a version
      // worth sending: it would be refused for exactly the reason the floor exists.
      if (discovered && isAtLeastHubVersionFloor(discovered) && discovered !== hubVersion) {
        logger().info("version-discovered", { from: hubVersion, to: discovered });
        hubVersion = discovered;
      }
    } catch (error) {
      logger().info("version-unavailable", {
        using: hubVersion,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return hubVersionFetch;
}

/** The `User-Agent` the real client sends, which is what the gateway reads. */
export function getAntigravityHubUserAgent(): string {
  return `antigravity/hub/${hubVersion} (aidev_client; os_type=${HUB_OS}; arch=${HUB_ARCH}; cl=${HUB_CLIENT_BUILD})`;
}
