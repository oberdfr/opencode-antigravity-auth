import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";

const { createLegacyPlugin } = vi.hoisted(() => ({
  createLegacyPlugin: vi.fn(),
}));

vi.mock("../plugin", () => ({ createAntigravityPlugin: createLegacyPlugin }));

import { AntigravityV2Plugin } from "./v2";

describe("Antigravity V2 plugin setup", () => {
  let cleanup: (() => void | Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.clearAllMocks();
  });

  it("registers Antigravity OAuth, Google models, the request hook, and search tool", async () => {
    const authorize = vi.fn(async () => ({
      method: "code" as const,
      url: "https://accounts.google.com/o/oauth2/auth",
      instructions: "Authorize Antigravity",
      callback: async (code: string) => ({
        type: "success" as const,
        refresh: `refresh-${code}`,
        access: "access-token",
        expires: 123456,
        email: "user@example.com",
        projectId: "project-123",
      }),
    }));
    const legacyPlugin = {
      auth: {
        methods: [{ type: "oauth", label: "Google OAuth (Antigravity)", authorize }],
        loader: vi.fn(),
      },
      event: vi.fn(),
    };
    createLegacyPlugin.mockReturnValue(async () => legacyPlugin);

    const methodUpdate = vi.fn();
    const providerAdd = vi.fn();
    const modelSet = vi.fn();
    const toolAdd = vi.fn();
    const rpcRegister = vi.fn(async () => ({ dispose: async () => undefined }));
    const sessionHook = vi.fn(async (..._args: unknown[]) => ({ dispose: async () => undefined }));
    const integrationTransform = async (callback: (editor: unknown) => void) => {
      callback({ method: { update: methodUpdate } });
      return { dispose: async () => undefined };
    };
    const providerTransform = async (callback: (editor: unknown) => void) => {
      callback({
        get: () => undefined,
        add: providerAdd,
        models: { set: modelSet },
      });
      return { dispose: async () => undefined };
    };
    const toolTransform = async (callback: (editor: unknown) => void) => {
      callback({ add: toolAdd });
      return { dispose: async () => undefined };
    };
    const ctx = {
      location: { directory: "/project" },
      integration: { transform: integrationTransform, connection: { active: vi.fn(), resolve: vi.fn() } },
      provider: { transform: providerTransform },
      rpc: { register: rpcRegister },
      session: { hook: sessionHook },
      tool: { transform: toolTransform },
      event: {
        subscribe: async function* ({ signal }: { signal: AbortSignal }) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      },
    } as unknown as Context;

    const setupCleanup = await AntigravityV2Plugin.setup(ctx);
    if (typeof setupCleanup === "function") cleanup = setupCleanup;

    expect(methodUpdate).toHaveBeenCalledOnce();
    const oauthRegistration = methodUpdate.mock.calls[0]?.[0] as {
      integrationID: string;
      method: { id: string; type: string; label: string };
      authorize: () => Promise<{
        mode: "code";
        callback: (code: string) => Promise<Record<string, unknown>>;
      }>;
      refresh: unknown;
    };
    expect(oauthRegistration).toMatchObject({
      integrationID: "google",
      method: { id: "antigravity", type: "oauth", label: "Google OAuth (Antigravity)" },
    });
    expect(oauthRegistration.refresh).toBeTypeOf("function");
    const flow = await oauthRegistration.authorize();
    expect(flow.mode).toBe("code");
    expect(await flow.callback("test-code")).toMatchObject({
      type: "oauth",
      methodID: "antigravity",
      refresh: "refresh-test-code",
      access: "access-token",
      metadata: { email: "user@example.com", projectId: "project-123" },
    });

    expect(providerAdd).toHaveBeenCalledOnce();
    const provider = providerAdd.mock.calls[0]?.[0] as { info: { id: string }; models: Array<{ id: string }> };
    expect(provider.info.id).toBe("google");
    expect(provider.models.some((model) => model.id === "antigravity-gemini-3.8-flash")).toBe(true);
    expect(modelSet).not.toHaveBeenCalled();

    expect(sessionHook).toHaveBeenCalledOnce();
    expect(sessionHook.mock.calls[0]?.[0]).toBe("http.request");
    expect(sessionHook.mock.calls[0]?.[2]).toEqual({ providerID: "google" });
    const requestHook = sessionHook.mock.calls[0]?.[1] as (event: {
      model: { id: string };
      request: Request;
    }) => void;
    const antigravityRequest = {
      model: { id: "antigravity-gemini-3.8-flash" },
      request: new Request("https://generativelanguage.googleapis.com/v1beta/models/test:generateContent", {
        method: "POST",
        body: "{}",
      }),
    };
    requestHook(antigravityRequest);
    expect(new URL(antigravityRequest.request.url).hostname).toBe("127.0.0.1");
    expect(antigravityRequest.request.headers.get("x-opencode-antigravity-target")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent",
    );
    const otherModelRequest = {
      model: { id: "not-registered" },
      request: new Request("https://generativelanguage.googleapis.com/v1beta/models/test:generateContent"),
    };
    requestHook(otherModelRequest);
    expect(otherModelRequest.request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent",
    );
    expect(toolAdd).toHaveBeenCalledOnce();
    expect(toolAdd.mock.calls[0]?.[0]).toMatchObject({ name: "google_search" });

    expect(rpcRegister).toHaveBeenCalledOnce();
    const [rpcDefinition, rpcHandlers] = (rpcRegister.mock.calls[0] ?? []) as unknown as [
      { id: string },
      { quota: unknown },
    ];
    expect(rpcDefinition.id).toBe("antigravity");
    expect(typeof rpcHandlers.quota).toBe("function");
  });
});
