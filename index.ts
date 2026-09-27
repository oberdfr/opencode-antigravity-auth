export {
  AntigravityCLIOAuthPlugin,
  GoogleOAuthPlugin,
} from "./src/plugin.js";

// OpenCode loads plugins via default export.
import { AntigravityCLIOAuthPlugin as _AntigravityPlugin } from "./src/plugin.js";
import { AntigravityV2Plugin as _AntigravityV2Plugin } from "./src/plugin/v2.js";

// V2 uses setup(ctx); retaining server(ctx) keeps this package usable on V1
// releases that support object-style plugin entrypoints.
export default {
  ..._AntigravityV2Plugin,
  server: _AntigravityPlugin,
};

export {
  authorizeAntigravity,
  exchangeAntigravity,
} from "./src/antigravity/oauth.js";

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./src/antigravity/oauth.js";
