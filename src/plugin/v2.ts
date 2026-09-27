import { Plugin, Provider } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { executeSearch } from "./search";
import { accessTokenExpired, formatRefreshParts, isOAuthAuth, parseRefreshParts } from "./auth";
import { refreshAccessToken } from "./token";
import { loadAccounts } from "./storage";
import { createAntigravityPlugin } from "../plugin";
import { OPENCODE_MODEL_DEFINITIONS } from "./config/models";
import type { PluginClient, PluginResult, OAuthAuthDetails, Provider as LegacyProvider } from "./types";
import { startAntigravityProxy, type LegacyFetch } from "./v2-proxy";
import { completeOAuth, toV2Model } from "./v2-adapters";
import { AntigravityRpc, createAntigravityQuotaHandler } from "./rpc";

const PLUGIN_ID = "opencode-antigravity-auth";
const OAUTH_METHOD_ID = "antigravity";
const modelIDs = new Set(Object.keys(OPENCODE_MODEL_DEFINITIONS));

export const AntigravityV2Plugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const client = createLegacyClient(ctx);
    const legacyPlugin = await createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)({
      client,
      directory: ctx.location.directory,
    });

    await registerOAuth(ctx, legacyPlugin, client);
    await registerModels(ctx);

    // Read-only quota surface for other plugins (for example opencode-quota).
    // Disposing happens automatically when the plugin unloads.
    await ctx.rpc.register(AntigravityRpc, {
      quota: createAntigravityQuotaHandler(client),
    });

    let fetchPromise: Promise<LegacyFetch> | undefined;
    const proxy = await startAntigravityProxy(async () => {
      fetchPromise ??= createLegacyFetch(ctx, legacyPlugin, client);
      return fetchPromise;
    });

    await ctx.session.hook(
      "http.request",
      (event) => {
        if (!modelIDs.has(event.model.id)) return;

        let target: URL;
        try {
          target = new URL(event.request.url);
        } catch {
          return;
        }
        if (target.protocol !== "https:" || target.hostname !== "generativelanguage.googleapis.com") return;

        const headers = new Headers(event.request.headers);
        headers.set("x-opencode-antigravity-target", target.toString());
        headers.set("x-opencode-antigravity-token", proxy.token);
        const init: RequestInit & { duplex?: "half" } = {
          method: event.request.method,
          headers,
          signal: event.request.signal,
        };
        if (event.request.body && event.request.method !== "GET" && event.request.method !== "HEAD") {
          init.body = event.request.body;
          init.duplex = "half";
        }
        event.request = new Request(proxy.url, init);
      },
      { providerID: ANTIGRAVITY_PROVIDER_ID },
    );

    await registerSearchTool(ctx, client);

    const eventController = new AbortController();
    void subscribeEvents(ctx, legacyPlugin, eventController.signal);

    return async () => {
      eventController.abort();
      await proxy.close();
    };
  },
});

async function registerOAuth(ctx: Context, plugin: PluginResult, client: PluginClient): Promise<void> {
  const authMethod = plugin.auth.methods.find((method) => method.type === "oauth");
  if (!authMethod?.authorize) {
    throw new Error("The Antigravity OAuth method could not be initialized");
  }

  await ctx.integration.transform((editor) => {
    editor.method.update({
      integrationID: ANTIGRAVITY_PROVIDER_ID,
      method: {
        id: OAUTH_METHOD_ID,
        type: "oauth",
        label: authMethod.label,
      },
      authorize: async () => {
        const authorization = await authMethod.authorize?.();
        if (!authorization) throw new Error("Antigravity authorization did not return a login flow");

        if (authorization.method === "auto") {
          return {
            url: authorization.url,
            instructions: authorization.instructions,
            mode: "auto" as const,
            callback: completeOAuth(authorization.callback()),
          };
        }

        return {
          url: authorization.url,
          instructions: authorization.instructions,
          mode: "code" as const,
          callback: async (code: string) => completeOAuth(authorization.callback(code)),
        };
      },
      refresh: async (credential) => {
        const auth: OAuthAuthDetails = {
          type: "oauth",
          refresh: credential.refresh,
          access: credential.access,
          expires: credential.expires,
        };
        const refreshed = await refreshAccessToken(auth, client, ANTIGRAVITY_PROVIDER_ID);
        if (!refreshed) throw new Error("Antigravity access-token refresh failed");
        return {
          ...credential,
          refresh: refreshed.refresh,
          access: refreshed.access ?? "",
          expires: refreshed.expires ?? 0,
        };
      },
      label: (credential) => {
        const email = credential.metadata?.email;
        return typeof email === "string" && email ? email : undefined;
      },
    });
  });
}

async function registerModels(ctx: Context): Promise<void> {
  const providerID = Provider.ID.make(ANTIGRAVITY_PROVIDER_ID);
  const models = Object.entries(OPENCODE_MODEL_DEFINITIONS).map(([id, definition]) => toV2Model(providerID, id, definition));

  await ctx.provider.transform((editor) => {
    const existing = editor.get(ANTIGRAVITY_PROVIDER_ID);
    if (existing) {
      const inventory = new Map(existing.models);
      for (const model of models) inventory.set(model.id, model);
      editor.models.set(ANTIGRAVITY_PROVIDER_ID, [...inventory.values()]);
      return;
    }

    editor.add({
      info: {
        ...Provider.Info.empty(providerID),
        name: "Google",
        activation: "enabled",
        package: "@opencode/ai/providers/google",
      },
      models,
    });
  });
}

async function createLegacyFetch(ctx: Context, plugin: PluginResult, client: PluginClient): Promise<LegacyFetch> {
  const loader = plugin.auth.loader;
  const getAuth = async () => {
    const connection = await ctx.integration.connection.active(ANTIGRAVITY_PROVIDER_ID);
    if (connection) {
      const credential = await ctx.integration.connection.resolve(connection);
      if (credential?.type === "oauth" && credential.methodID === OAUTH_METHOD_ID) {
        return {
          type: "oauth" as const,
          refresh: credential.refresh,
          access: credential.access,
          expires: credential.expires,
        };
      }
    }

    const savedAccounts = await loadAccounts();
    const account = savedAccounts?.accounts[savedAccounts.activeIndex] ?? savedAccounts?.accounts[0];
    if (!account?.refreshToken) return { type: "none" };
    return {
      type: "oauth" as const,
      refresh: formatRefreshParts({
        refreshToken: account.refreshToken,
        projectId: account.projectId,
        managedProjectId: account.managedProjectId,
      }),
      access: "",
      expires: 0,
    };
  };

  const auth = await getAuth();
  if (!isOAuthAuth(auth)) {
    throw new Error("Connect an Antigravity account in OpenCode before using an Antigravity model");
  }

  const provider: LegacyProvider = { models: {} };
  const loaded = await loader(getAuth, provider);
  if (!("fetch" in loaded) || typeof loaded.fetch !== "function") {
    throw new Error("OpenCode did not provide an Antigravity request handler");
  }
  return loaded.fetch as LegacyFetch;
}

async function registerSearchTool(ctx: Context, client: PluginClient): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "google_search",
      description:
        "Search the web using Google Search and analyze URLs. If the user mentions URLs, include them in the urls parameter.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query or question" },
          urls: { type: "array", items: { type: "string" }, description: "URLs to fetch and analyze" },
          thinking: { type: "boolean", default: true, description: "Enable deeper analysis" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const args = input as { query: string; urls?: string[]; thinking?: boolean };
        const connection = await ctx.integration.connection.active(ANTIGRAVITY_PROVIDER_ID);
        const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
        if (!credential || credential.type !== "oauth" || credential.methodID !== OAUTH_METHOD_ID) {
          return { content: "Not connected to Antigravity. Use /connect and choose Google OAuth (Antigravity)." };
        }

        let auth: OAuthAuthDetails = {
          type: "oauth",
          refresh: credential.refresh,
          access: credential.access,
          expires: credential.expires,
        };
        if (!isOAuthAuth(auth)) {
          return { content: "The active Google connection is not an Antigravity OAuth connection." };
        }
        if (!auth.access || accessTokenExpired(auth)) {
          const refreshed = await refreshAccessToken(auth, client, ANTIGRAVITY_PROVIDER_ID);
          if (!refreshed?.access) return { content: "Could not refresh the Antigravity access token." };
          auth = refreshed;
        }

        const parts = parseRefreshParts(auth.refresh);
        const projectID = parts.managedProjectId || parts.projectId || "unknown";
        const result = await executeSearch(
          {
            query: args.query,
            urls: args.urls,
            thinking: args.thinking ?? true,
          },
          auth.access ?? "",
          projectID,
          context.signal,
        );
        return { content: result };
      },
    });
  });
}

function createLegacyClient(ctx: Context): PluginClient {
  const client = {
    app: {
      log: async ({ body }: { body: { service?: string; level?: string; message?: string; extra?: unknown } }) => {
        const message = `[${body.service ?? PLUGIN_ID}] ${body.message ?? ""}`;
        if (body.level === "error") console.error(message, body.extra ?? "");
        else if (body.level === "warn") console.warn(message, body.extra ?? "");
        else console.info(message, body.extra ?? "");
        return { data: undefined };
      },
    },
    tui: {
      showToast: async ({ body }: { body: { title?: string; message: string; variant?: string } }) => {
        const title = body.title ? `${body.title}: ` : "";
        if (body.variant === "error" || body.variant === "warning") console.warn(`[Antigravity Auth] ${title}${body.message}`);
        else console.info(`[Antigravity Auth] ${title}${body.message}`);
        return { data: undefined };
      },
    },
    auth: {
      set: async () => undefined,
    },
    session: {
      abort: async ({ path }: { path: { id: string } }) => ctx.session.interrupt({ sessionID: path.id, resume: false }),
      messages: async ({ path }: { path: { id: string } }) => ({
        data: await ctx.session.context({ sessionID: path.id }),
      }),
      prompt: async ({
        path,
        body,
      }: {
        path: { id: string };
        body: { parts?: Array<{ type?: string; text?: string }> };
      }) => {
        const text = (body.parts ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
        if (!text) throw new Error("V2 sessions do not accept synthetic tool-result prompt parts");
        return ctx.session.prompt({ sessionID: path.id, text });
      },
    },
  };
  return client as unknown as PluginClient;
}

async function subscribeEvents(pluginContext: Context, plugin: PluginResult, signal: AbortSignal): Promise<void> {
  try {
    for await (const rawEvent of pluginContext.event.subscribe({ signal })) {
      if (signal.aborted) return;
      const event = asRecord(rawEvent);
      const type = typeof event.type === "string" ? event.type : "unknown";
      const properties = event.properties ?? event.data ?? event;
      await plugin.event?.({ event: { type, properties } });
    }
  } catch (error) {
    if (!signal.aborted) console.warn(`[Antigravity Auth] Event subscription stopped: ${String(error)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}
