import { describe, expect, it } from "vitest";

import { OPENCODE_MODEL_DEFINITIONS } from "./models";

const getModel = (name: string) => {
  const model = OPENCODE_MODEL_DEFINITIONS[name];
  if (!model) {
    throw new Error(`Missing model definition for ${name}`);
  }
  return model;
};

describe("OPENCODE_MODEL_DEFINITIONS", () => {
  it("includes the full set of configured models", () => {
    const modelNames = Object.keys(OPENCODE_MODEL_DEFINITIONS).sort();

    expect(modelNames).toEqual([
      "antigravity-claude-opus-4-6-thinking",
      "antigravity-claude-sonnet-4-6",
      "antigravity-gemini-3-flash",
      "antigravity-gemini-3-pro",
      "antigravity-gemini-3.1-pro",
      "antigravity-gemini-3.6-flash",
      "antigravity-gemini-3.7-flash",
      "antigravity-gemini-3.8-flash",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      // Kept as its own entry even though requests for it are served by 3.1 Pro: the
      // id is in people's saved config, and a model that is gone from the picker is
      // harder to notice than one that quietly works.
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
    ]);
  });

  it("defines Gemini 3 variants for Antigravity models", () => {
    expect(getModel("antigravity-gemini-3-pro").variants).toEqual({
      low: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
      high: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    });

    expect(getModel("antigravity-gemini-3.1-pro").variants).toEqual({
      low: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
      high: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    });

    expect(getModel("antigravity-gemini-3-flash").variants).toEqual({
      minimal: { thinkingConfig: { includeThoughts: true, thinkingLevel: "minimal" } },
      low: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
      medium: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } },
      high: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    });
  });

  it("defines tiered flash variants for Gemini 3.6/3.7/3.8", () => {
    // Nested under thinkingConfig because that is the shape OpenCode translates into
    // the request; a bare thinkingLevel is dropped before it reaches the model.
    const expected = {
      low: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
      medium: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } },
      high: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    };
    expect(getModel("antigravity-gemini-3.6-flash").variants).toEqual(expected);
    expect(getModel("antigravity-gemini-3.7-flash").variants).toEqual(expected);
    expect(getModel("antigravity-gemini-3.8-flash").variants).toEqual(expected);
  });

  it("defines thinking budget variants for Claude thinking models", () => {
    expect(getModel("antigravity-claude-opus-4-6-thinking").variants).toEqual({
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    });
  });
});
