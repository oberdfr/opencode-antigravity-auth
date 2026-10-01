/**
 * What the gateway reads out of the user agent, and the one thing in it that matters.
 *
 * The gateway gates the newer models on the client version named in this header, and
 * refuses a request whose version it does not recognise with a 403 that reads like a
 * licensing problem: "You do not have a valid license of this product ... please try
 * using the latest version and logging in again" (#3501). It is not a licensing problem,
 * and the same account is served the same model minutes later with a header that names
 * the version the gateway expects.
 *
 * So the version in here is the hub's, not the application's. They come from different
 * services and are not the same number, which is exactly what makes this easy to get
 * wrong and hard to notice: the header is present, well formed, and refused.
 */

import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_HUB_VERSION_FALLBACK,
  ensureAntigravityHubVersion,
  getAntigravityHubUserAgent,
  getAntigravityHubVersion,
  isAtLeastHubVersionFloor,
  parseHubManifestVersion,
} from "./hub-version";
import { buildFingerprintHeaders, collectCurrentFingerprint, generateFingerprint } from "./fingerprint";

describe("the client version the gateway is told", () => {
  it("is the hub's, in the shape the real client sends", () => {
    const agent = getAntigravityHubUserAgent();

    expect(agent).toMatch(
      /^antigravity\/hub\/\d+\.\d+\.\d+ \(aidev_client; os_type=\w+; arch=\w+; cl=\d+\)$/,
    );
  });

  it("is the hub version, not the application's", () => {
    // The two come from different services and are not the same number. Sending the
    // application's version where the hub's belongs is the 403.
    expect(getAntigravityHubUserAgent()).toContain(`/hub/${getAntigravityHubVersion()}`);
  });

  it("is at least the version the newer models are gated on", () => {
    // Below this the gateway refuses the newer models outright.
    expect(isAtLeastHubVersionFloor(getAntigravityHubVersion())).toBe(true);
  });

  it("falls back to the reference version before anything is discovered", () => {
    expect(ANTIGRAVITY_HUB_VERSION_FALLBACK).toBe("2.8.0");
    expect(isAtLeastHubVersionFloor(ANTIGRAVITY_HUB_VERSION_FALLBACK)).toBe(true);
  });
});

describe("a version older than the gateway serves", () => {
  it("is not worth sending", () => {
    // A manifest that parses but names something below the floor is not newer: sending it
    // is refused for exactly the reason the floor exists.
    expect(isAtLeastHubVersionFloor("2.7.9")).toBe(false);
    expect(isAtLeastHubVersionFloor("1.18.3")).toBe(false);
  });

  it("does not block a version that is newer", () => {
    expect(isAtLeastHubVersionFloor("2.8.1")).toBe(true);
    expect(isAtLeastHubVersionFloor("3.0.0")).toBe(true);
    expect(isAtLeastHubVersionFloor("2.10.0")).toBe(true);
  });
});

describe("reading the hub manifest", () => {
  it("takes the version out of an electron-builder manifest", () => {
    const manifest = [
      "version: 2.9.1",
      "files:",
      "  - url: Agent-x64.exe",
    ].join("\n");

    expect(parseHubManifestVersion(manifest)).toBe("2.9.1");
  });

  it("reads a quoted version", () => {
    expect(parseHubManifestVersion(`version: '3.0.0'\nsha512: abc`)).toBe("3.0.0");
    expect(parseHubManifestVersion('version: "3.0.1"  # comment')).toBe("3.0.1");
  });

  it("returns null when there is no version line", () => {
    expect(parseHubManifestVersion("files:\n  - url: Agent.exe")).toBeNull();
    expect(parseHubManifestVersion("")).toBeNull();
  });

  it("refuses a version that is not three numbers", () => {
    // Anything else in that position would be sent to the gateway as a version.
    expect(parseHubManifestVersion("version: 2.8")).toBeNull();
    expect(parseHubManifestVersion("version: latest")).toBeNull();
  });
});

describe("discovery", () => {
  it("leaves a version the gateway serves, discovered or not", async () => {
    // Reached with the network up or down, the outcome that matters is the same: a version
    // that names something the gateway will serve. The manifest moves it, never below it.
    await ensureAntigravityHubVersion();

    expect(isAtLeastHubVersionFloor(getAntigravityHubVersion())).toBe(true);
    expect(getAntigravityHubVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("the header that goes out", () => {
  it("is the hub agent, whatever the fingerprint was saved with", () => {
    // A fingerprint stored before this was true would keep sending a version the gateway
    // refuses, so the header is built at send time rather than read off the fingerprint.
    const stale = {
      ...collectCurrentFingerprint(),
      userAgent: "antigravity/1.18.3 linux/x64",
    };

    expect(buildFingerprintHeaders(stale)?.["User-Agent"]).toBe(getAntigravityHubUserAgent());
  });

  it("is the same for every fingerprint the plugin generates", () => {
    // The gateway reads the version, not the client build, and platform and architecture
    // are pinned to the client the version was captured from. Varying them would make two
    // requests from one account look like two machines, for nothing.
    const agents = new Set(
      Array.from({ length: 6 }, () => generateFingerprint().userAgent),
    );

    expect(agents.size).toBe(1);
    expect([...agents][0]).toBe(getAntigravityHubUserAgent());
  });
});
