export { AntigravityCLIOAuthPlugin, GoogleOAuthPlugin, } from "./src/plugin.js";
declare const _default: {
    server: ({ client, directory }: import("./src/plugin/types.js").PluginContext) => Promise<import("./src/plugin/types.js").PluginResult>;
    id: string;
    setup: (context: import("@opencode/plugin/promise/plugin").Context) => Promise<import("@opencode/plugin/promise/plugin").Cleanup | void> | import("@opencode/plugin/promise/plugin").Cleanup | void;
};
export default _default;
export { authorizeAntigravity, exchangeAntigravity, } from "./src/antigravity/oauth.js";
export type { AntigravityAuthorization, AntigravityTokenExchangeResult, } from "./src/antigravity/oauth.js";
//# sourceMappingURL=index.d.ts.map