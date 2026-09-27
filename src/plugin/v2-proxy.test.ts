import { afterEach, describe, expect, it, vi } from "vitest";
import { startAntigravityProxy, type LegacyFetch } from "./v2-proxy";

const TARGET_HEADER = "x-opencode-antigravity-target";
const TOKEN_HEADER = "x-opencode-antigravity-token";

describe("Antigravity V2 request proxy", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("forwards the target request and streams the upstream response", async () => {
    const fetchMock = vi.fn<LegacyFetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/test:streamGenerateContent?alt=sse");
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer access-token");
      expect(request.headers.get("x-client-marker")).toBe("preserved");
      expect(await request.text()).toBe('{"contents":[{"parts":[{"text":"hello"}]}]}');

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            controller.enqueue(new TextEncoder().encode("data: second\n\n"));
            controller.close();
          },
        }),
        { status: 202, headers: { "content-type": "text/event-stream", "x-upstream": "antigravity" } },
      );
    });
    const proxy = await startAntigravityProxy(async () => fetchMock);
    close = proxy.close;

    const response = await fetch(proxy.url, {
      method: "POST",
      headers: {
        [TARGET_HEADER]: "https://generativelanguage.googleapis.com/v1beta/models/test:streamGenerateContent?alt=sse",
        [TOKEN_HEADER]: proxy.token,
        authorization: "Bearer access-token",
        "content-type": "application/json",
        "x-client-marker": "preserved",
      },
      body: '{"contents":[{"parts":[{"text":"hello"}]}]}',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-upstream")).toBe("antigravity");
    expect(await response.text()).toBe("data: first\n\ndata: second\n\n");
  });

  it("rejects requests without its loopback token", async () => {
    const fetchMock = vi.fn<LegacyFetch>();
    const proxy = await startAntigravityProxy(async () => fetchMock);
    close = proxy.close;

    const response = await fetch(proxy.url, {
      method: "POST",
      headers: {
        [TARGET_HEADER]: "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent",
        [TOKEN_HEADER]: "invalid-token",
      },
      body: "{}",
    });

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects targets outside the Google Generative Language API", async () => {
    const fetchMock = vi.fn<LegacyFetch>();
    const proxy = await startAntigravityProxy(async () => fetchMock);
    close = proxy.close;

    const response = await fetch(proxy.url, {
      method: "POST",
      headers: {
        [TARGET_HEADER]: "https://example.com/v1beta/models/test:generateContent",
        [TOKEN_HEADER]: proxy.token,
      },
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
