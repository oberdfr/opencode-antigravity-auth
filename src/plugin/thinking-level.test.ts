/**
 * A thinking setting that looks applied and does the opposite.
 *
 * Gemini 3 asks for thinking with a level, not a token count, and this used to decide
 * whether thinking was enabled by looking for the count alone. Every level-based request
 * therefore counted as disabled, and the include flag was resolved from that verdict:
 * false. The gateway was asked for `high`, did the work, and returned none of it, so the
 * setting read as working and produced no reasoning at all.
 */

import { describe, expect, it } from "vitest";
import { normalizeThinkingConfig } from "./request-helpers";

describe("thinking requested by level rather than by budget", () => {
  it("counts as enabled, so the reasoning is not switched off", () => {
    // The shape OpenCode sends for a Gemini 3 variant.
    const result = normalizeThinkingConfig({ thinkingLevel: "high", includeThoughts: true });

    expect(result?.includeThoughts).toBe(true);
    expect(result?.thinkingLevel).toBe("high");
  });

  it("keeps the level instead of turning it into a token budget", () => {
    const result = normalizeThinkingConfig({ thinkingLevel: "medium", includeThoughts: true });

    expect(result?.thinkingLevel).toBe("medium");
    // Inventing a budget here is what let the level be dropped downstream.
    expect(result?.thinkingBudget).toBeUndefined();
  });

  it("still shows the thinking when the request says nothing about showing it", () => {
    // The level says how much to think; whether any of it reaches the client is a
    // separate switch, and asking to think without saying otherwise means show it.
    const result = normalizeThinkingConfig({ thinkingLevel: "high" });

    expect(result?.includeThoughts).toBe(true);
  });

  it("honours an explicit request not to show it", () => {
    const result = normalizeThinkingConfig({ thinkingLevel: "high", includeThoughts: false });

    expect(result?.includeThoughts).toBe(false);
  });

  it("reads the snake_case spelling too", () => {
    expect(normalizeThinkingConfig({ thinking_level: "low", include_thoughts: true })).toEqual({
      thinkingLevel: "low",
      includeThoughts: true,
    });
  });
});

describe("thinking requested by budget, which is what Claude and Gemini 2.5 use", () => {
  it("behaves as it did before", () => {
    expect(normalizeThinkingConfig({ thinkingBudget: 8192, includeThoughts: true })).toEqual({
      thinkingBudget: 8192,
      includeThoughts: true,
    });
  });

  it("treats a zero budget as no thinking, and says so explicitly", () => {
    // The zero is kept rather than dropped, because "stop thinking" is an instruction
    // and dropping the field would let the gateway apply its own default instead.
    expect(normalizeThinkingConfig({ thinkingBudget: 0 })).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    });
  });

  it("is still absent when there is nothing to think with", () => {
    expect(normalizeThinkingConfig(undefined)).toBeUndefined();
    expect(normalizeThinkingConfig({})).toBeUndefined();
  });
});

describe("a level together with a budget", () => {
  it("keeps both, and lets the caller prefer the level", () => {
    // The gateway takes one or the other; passing both through leaves that choice
    // visible instead of silently discarding what the client asked for.
    const result = normalizeThinkingConfig({ thinkingLevel: "high", thinkingBudget: 4096 });

    expect(result?.thinkingLevel).toBe("high");
    expect(result?.thinkingBudget).toBe(4096);
    expect(result?.includeThoughts).toBe(true);
  });
});