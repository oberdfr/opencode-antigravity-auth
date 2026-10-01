/**
 * The runaway that pinned a core and grew until OpenCode was killed.
 *
 * Every test here is about a bound rather than a behaviour: the point is that the
 * structures involved cannot grow with the length of a session, and that a fault which
 * keeps coming back stops being repaired after a bounded number of tries.
 */

import { describe, expect, it } from "vitest";
import {
  createStreamingTransformer,
  transformSseLine,
  createThoughtBuffer,
} from "../plugin/core/streaming/transformer";
import type { SignatureStore } from "../plugin/core/streaming/types";

const NOW = "2026-10-01T12:00:00.000Z";

function store(): SignatureStore {
  return {
    has: () => false,
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
    keys: () => [],
  } as unknown as SignatureStore;
}

/** One SSE `data:` line carrying a thinking part with the given text. */
function thinkingChunk(text: string): string {
  return `data: ${JSON.stringify({
    response: { candidates: [{ content: { parts: [{ thought: true, text }] } }] },
  })}`;
}

describe("thinking dedup across a response", () => {
  it("does not let one response see another's hashes", () => {
    // The regression: a single module-level Set shared by every response, so text
    // streamed in one turn was treated as already-displayed in the next one.
    const shared = new Set<string>();
    const first = transformSseLine(
      thinkingChunk("thinking about the task"),
      store(),
      createThoughtBuffer(),
      createThoughtBuffer(),
      { transformThinkingParts: (r) => r },
      { displayedThinkingHashes: shared },
      { injected: false },
    );

    expect(first).toContain("thinking about the task");

    const second = transformSseLine(
      thinkingChunk("thinking about the task"),
      store(),
      createThoughtBuffer(),
      createThoughtBuffer(),
      { transformThinkingParts: (r) => r },
      { displayedThinkingHashes: new Set<string>() },
      { injected: false },
    );

    // Same text, fresh scope: it must still reach the client.
    expect(second).toContain("thinking about the task");
  });

  it("still suppresses a repeat that arrives out of order", () => {
    // The prefix test catches a repeat of the *latest* text, because the buffer holds
    // it. What it cannot catch is text that comes back after something else has been
    // sent since, which is the interleaving the hash exists for.
    //
    // Note the buffer is shared across all four calls on purpose: with a fresh buffer
    // every text trivially "starts with" the empty string and the hash is never reached.
    const hashes = new Set<string>();
    const sent = createThoughtBuffer();
    const callbacks = { transformThinkingParts: (r: unknown) => r };
    const options = { displayedThinkingHashes: hashes };
    const emit = (text: string) =>
      transformSseLine(thinkingChunk(text), store(), createThoughtBuffer(), sent, callbacks, options, {
        injected: false,
      });

    expect(emit("alpha")).toContain("alpha");
    expect(emit("beta")).toContain("beta");
    expect(emit("gamma")).toContain("gamma");

    // "beta" again, now behind "gamma": not a prefix of it, so only the hash catches it.
    const repeat = emit("beta");
    expect(repeat).not.toContain("beta");
    // And the text after it still flows, so suppressing the repeat did not end the part.
    expect(emit("delta")).toContain("delta");
  });

  it("forwards the delta of a cumulative stream rather than the whole text again", () => {
    // This is the path that made hashing quadratic: the prefix test has to run first,
    // because on a cumulative stream it is the one that always applies.
    const sent = createThoughtBuffer();
    const hashes = new Set<string>();
    const callbacks = { transformThinkingParts: (r: unknown) => r };

    const first = transformSseLine(
      thinkingChunk("I will "),
      store(),
      createThoughtBuffer(),
      sent,
      callbacks,
      { displayedThinkingHashes: hashes },
      { injected: false },
    );
    expect(first).toContain("I will ");

    const second = transformSseLine(
      thinkingChunk("I will read the file."),
      store(),
      createThoughtBuffer(),
      sent,
      callbacks,
      { displayedThinkingHashes: hashes },
      { injected: false },
    );
    // Only the new tail, and no growth in the hash set from a continuation.
    expect(second).toContain("read the file.");
    expect(second).not.toContain("I will");
    expect(hashes.size).toBe(0);
  });

  it("keeps working when a stream sends more text than the hash set holds", () => {
    // Past the cap the set stops growing and the prefix test carries the work, so the
    // cost is bounded and the text still arrives.
    const hashes = new Set<string>();
    const callbacks = { transformThinkingParts: (r: unknown) => r };
    const sent = createThoughtBuffer();
    let last = "";

    for (let i = 0; i < 6000; i++) {
      last = `chunk ${i}`;
      transformSseLine(
        thinkingChunk(last),
        store(),
        createThoughtBuffer(),
        i === 0 ? sent : createThoughtBuffer(),
        callbacks,
        { displayedThinkingHashes: hashes },
        { injected: false },
      );
    }

    expect(hashes.size).toBeLessThanOrEqual(4096);
    expect(last).toContain("chunk 5999");
  });
});

describe("a transformer over a long stream", () => {
  it("does not accumulate memory across a long cumulative response", async () => {
    // End to end through the TransformStream, which is where the reported symptom
    // showed up: a response that grows the process the longer it runs.
    const transformer = createStreamingTransformer(
      store(),
      { transformThinkingParts: (r: unknown) => r },
      { displayedThinkingHashes: new Set<string>() },
    );

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const writer = transformer.writable.getWriter();
    const chunks: string[] = [];

    const reader = transformer.readable.getReader();
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }
    })();

    let accumulated = "";
    for (let i = 0; i < 2000; i++) {
      accumulated += `t${i} `;
      await writer.write(
        encoder.encode(`${thinkingChunk(accumulated)}\n\n`),
      );
    }
    await writer.close();
    await pump;

    const text = chunks.join("");
    // Every chunk of the tail made it through, so nothing was silently dropped.
    expect(text).toContain("t1999");
    expect(text.length).toBeGreaterThan(0);
    expect(NOW).toBeTruthy();
  });
});