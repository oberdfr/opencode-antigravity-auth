/**
 * What the gateway is actually asked for, given what OpenCode sends.
 *
 * Two things had to line up for a thinking level to do anything: the level has to
 * survive the trip from the variant to the request, and the request has to say that the
 * reasoning should be returned. Both are checked here against the body that leaves the
 * plugin, because a level that is accepted by the UI and then dropped on the way to
 * Google looks exactly like one that works.
 */

import { describe, expect, it } from "vitest";
import { prepareAntigravityRequest } from "./request";
import { OPENCODE_MODEL_DEFINITIONS } from "./config/models";
import { toV2Model } from "./v2-adapters";
import { Provider } from "@opencode/plugin";

const GOOGLE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * The request body OpenCode builds for a model, before the plugin touches it.
 *
 * OpenCode sends the variant's settings folded into generationConfig.thinkingConfig
 * and sends no providerOptions at all, which is what the plugin actually receives.
 */
function opencodeBody(model: string, variant?: string) {
  const definition = OPENCODE_MODEL_DEFINITIONS[model];
  const registered = toV2Model(Provider.ID.make("google-antigravity"), model, definition!);
  const entry = registered.variants?.find((v) => v.id === variant);

  return {
    contents: [{ role: "user", parts: [{ text: "ciao" }] }],
    ...(entry?.settings?.thinkingConfig
      ? { generationConfig: { maxOutputTokens: 65536, thinkingConfig: entry.settings.thinkingConfig } }
      : { generationConfig: { maxOutputTokens: 65536 } }),
  };
}

/** The thinkingConfig of the body the plugin puts on the wire. */
function sentThinkingConfig(model: string, variant?: string) {
  const prepared = prepareAntigravityRequest(
    `${GOOGLE}/${model}:streamGenerateContent`,
    {
      method: "POST",
      body: JSON.stringify(opencodeBody(model, variant)),
      headers: { "content-type": "application/json" },
    },
    "token",
    "project",
    undefined,
    "antigravity",
    false,
    {},
  );

  const sent = JSON.parse(String(prepared.init.body)) as {
    model: string;
    request: { generationConfig?: { thinkingConfig?: Record<string, unknown> } };
  };

  return { model: sent.model, thinkingConfig: sent.request.generationConfig?.thinkingConfig };
}

describe("a chosen thinking level reaches the gateway", () => {
  it("carries the level and asks for the reasoning to be returned", () => {
    // The failure this guards against is quiet: the variant is accepted, the request
    // goes out, and the level is simply absent from it.
    const result = sentThinkingConfig("antigravity-gemini-3.8-flash", "high");

    expect(result.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
  });

  it("sends a different level when a different one is chosen", () => {
    const low = sentThinkingConfig("antigravity-gemini-3.8-flash", "low");

    expect(low.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
  });

  it("does not leave the level at the model default when one was asked for", () => {
    const chosen = sentThinkingConfig("antigravity-gemini-3.8-flash", "high");
    const fallback = sentThinkingConfig("antigravity-gemini-3.8-flash");

    // Otherwise a working high and a silently ignored one look identical from here.
    expect(chosen.thinkingConfig?.thinkingLevel).not.toBe(
      fallback.thinkingConfig?.thinkingLevel,
    );
  });

  it("always asks for the reasoning, whichever level is chosen", () => {
    for (const variant of ["low", "medium", "high"]) {
      expect(sentThinkingConfig("antigravity-gemini-3.8-flash", variant).thinkingConfig).toMatchObject({
        includeThoughts: true,
      });
    }
  });

  it("works the same on Gemini 3.1 Pro", () => {
    expect(sentThinkingConfig("antigravity-gemini-3.1-pro", "high").thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
  });
});

describe("declaring the variant", () => {
  it("puts the setting where OpenCode translates it, plus the matching request patch", () => {
    // settings is what a variant is expected to carry; body is what actually gets merged
    // into the request. Emitting one without the other produced a variant that looked
    // selectable and changed nothing.
    const registered = toV2Model(
      Provider.ID.make("google-antigravity"),
      "antigravity-gemini-3.8-flash",
      OPENCODE_MODEL_DEFINITIONS["antigravity-gemini-3.8-flash"]!,
    );
    const high = registered.variants?.find((v) => v.id === "high");

    expect(high?.settings).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
    });
    expect(high?.body).toEqual({
      generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    });
  });
});