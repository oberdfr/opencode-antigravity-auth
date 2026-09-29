/**
 * An Antigravity request is authenticated by the OAuth bearer, never by an API
 * key. The Google SDK still puts its key on the request in `x-goog-api-key`,
 * and Google answers that combination with "API key not valid" — a message that
 * reads like a credential problem and sent me looking at tokens and endpoints
 * before the stale header turned out to be the cause. Both key headers have to
 * come off, together.
 */

import { describe, expect, it } from "vitest";
import { prepareAntigravityRequest } from "./request.ts";

const GOOGLE_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tiered:streamGenerateContent";

function prepare(headers: Record<string, string>) {
  return prepareAntigravityRequest(
    GOOGLE_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    },
    "ya29.access-token",
    "rising-fact-p41fc",
  );
}

describe("API key headers on an Antigravity request", () => {
  it("carries the OAuth bearer instead of a key", () => {
    const { init } = prepare({});

    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer ya29.access-token");
  });

  it("strips the key the SDK leaves on the request", () => {
    // This is the one that caused it: the header survived alongside the bearer
    // and Google rejected the request with "API key not valid".
    const { init } = prepare({ "x-goog-api-key": "" });

    expect(new Headers(init.headers).get("x-goog-api-key")).toBeNull();
  });

  it("strips the older key header too", () => {
    const { init } = prepare({ "x-api-key": "sk-not-used" });

    expect(new Headers(init.headers).get("x-api-key")).toBeNull();
  });

  it("strips the project header that forces project-level checks", () => {
    const { init } = prepare({ "x-goog-user-project": "some-project" });

    expect(new Headers(init.headers).get("x-goog-user-project")).toBeNull();
  });
});
