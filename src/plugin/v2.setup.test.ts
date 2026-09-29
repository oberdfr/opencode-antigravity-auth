import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";

const { createLegacyPlugin } = vi.hoisted(() => ({
  createLegacyPlugin: vi.fn(),
}));

vi.mock("../plugin", () => ({ createAntigravityPlugin: createLegacyPlugin }));
// The account file is the last fallback for credentials. Reading the real one
// would make these tests depend on the machine they run on.
vi.mock("./storage", () => ({ loadAccounts: vi.fn(async () => null) }));

import { AntigravityV2Plugin, resolveAntigravityCredential } from "./v2";

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
    const providerGet = vi.fn(() => undefined);
    const providerTransform = async (callback: (editor: unknown) => void) => {
      callback({
        get: providerGet,
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
      integrationID: "google-antigravity",
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
    expect(provider.info.id).toBe("google-antigravity");
    expect(provider.models.some((model) => model.id === "antigravity-gemini-3.8-flash")).toBe(true);
    expect(modelSet).not.toHaveBeenCalled();
    // The built-in google provider belongs to OpenCode and authenticates with an
    // API key. Merging into it is what made two identical models show up and
    // what made the catalog ones fail with an invalid API key.
    expect(providerGet.mock.calls.flat()).not.toContain("google");

    expect(sessionHook).toHaveBeenCalledOnce();
    expect(sessionHook.mock.calls[0]?.[0]).toBe("http.request");
    expect(sessionHook.mock.calls[0]?.[2]).toEqual({ providerID: "google-antigravity" });
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

  it("finds a credential filed under the id this plugin had before the rename", async () => {
    // Login writes the credential and OpenCode's auth flow owns that, so a
    // connection made before the rename is still filed under "google". Reading it
    // there is what avoids making the user log in again.
    const connection = { id: "conn", integrationID: "google" };
    const active = vi.fn(async (integrationID: string) =>
      integrationID === "google" ? connection : undefined,
    );
    const credential = {
      type: "oauth" as const,
      methodID: "antigravity",
      refresh: "refresh-from-old-id",
      access: "access-token",
      expires: 1,
    };
    const resolve = vi.fn(async (target: unknown) => (target === connection ? credential : undefined));

    const found = await resolveAntigravityCredential({
      integration: { connection: { active, resolve } },
    } as unknown as Context);

    expect(found).toMatchObject({ refresh: "refresh-from-old-id" });
    // The new id is tried first, so a fresh login is preferred once there is one.
    expect(active.mock.calls[0]?.[0]).toBe("google-antigravity");
  });

  it("prefers the new integration id when both hold a credential", async () => {
    const fresh = { id: "new", integrationID: "google-antigravity" };
    const active = vi.fn(async (integrationID: string) => (integrationID === "google-antigravity" ? fresh : undefined));
    const resolve = vi.fn(async () => ({ type: "oauth" as const, methodID: "antigravity", refresh: "new-refresh" }));

    const found = await resolveAntigravityCredential({
      integration: { connection: { active, resolve } },
    } as unknown as Context);

    expect(found).toMatchObject({ refresh: "new-refresh" });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(fresh);
  });

  it("ignores a credential on the old id that is not an Antigravity login", async () => {
    // The built-in google provider's own credential must not be mistaken for an
    // Antigravity one, or the plugin would send an API key where OAuth is needed.
    const connection = { id: "conn", integrationID: "google" };
    const active = vi.fn(async (integrationID: string) => (integrationID === "google" ? connection : undefined));
    const resolve = vi.fn(async () => ({ type: "api" as const, key: "sk-something" }));

    const found = await resolveAntigravityCredential({
      integration: { connection: { active, resolve } },
    } as unknown as Context);

    expect(found).toBeUndefined();
  });
});
