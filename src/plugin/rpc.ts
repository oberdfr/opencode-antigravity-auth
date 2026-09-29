/**
 * Read-only RPC surface for the Antigravity plugin.
 *
 * Exposes the quota data that `checkAccountsQuota` already computes so other
 * plugins (for example opencode-quota) can display it without re-implementing
 * token refresh, project resolution, or quota aggregation. This module holds no
 * quota logic of its own and never writes account state.
 */

import { Rpc } from "@opencode/plugin/rpc";
import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { checkAccountsQuota } from "./quota";
import { loadAccounts, saveAccounts } from "./storage";
import type { AccountQuotaResult, QuotaGroup } from "./quota";
import type { PluginClient } from "./types";

const GROUP_LABELS: Record<QuotaGroup, string> = {
  claude: "Claude",
  "gemini-pro": "Gemini Pro",
  "gemini-flash": "Gemini Flash",
};

// One entry per window a family runs on, so the same family appears once for its
// five-hour window and once for its weekly one.
const quotaGroupSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    remainingPercent: { type: "number" },
    resetTime: { type: "string" },
    modelCount: { type: "number" },
    // Declared because the schema forbids extra properties: a field the handler
    // sets but the schema does not name is stripped from the response.
    windowMinutes: { type: "number" },
  },
  required: ["id", "label", "remainingPercent", "modelCount"],
  additionalProperties: false,
} as const;

const accountSchema = {
  type: "object",
  properties: {
    index: { type: "number" },
    email: { type: "string" },
    status: { type: "string", enum: ["ok", "disabled", "error"] },
    error: { type: "string" },
    enabled: { type: "boolean" },
    subscription: { type: "object" },
    groups: { type: "array", items: quotaGroupSchema },
  },
  required: ["index", "status", "enabled", "groups"],
  additionalProperties: false,
} as const;

export const AntigravityRpc = Rpc.define({
  id: "antigravity",
  methods: {
    quota: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          available: { type: "boolean" },
          reason: { type: "string" },
          accounts: { type: "array", items: accountSchema },
        },
        required: ["available", "accounts"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});

export type AntigravityQuotaOutput = {
  available: boolean;
  reason?: string;
  accounts: Array<{
    index: number;
    email?: string;
    status: "ok" | "disabled" | "error";
    error?: string;
    enabled: boolean;
    subscription?: { id: string; name?: string };
    groups: Array<{
      id: string;
      label: string;
      remainingPercent: number;
      resetTime?: string;
      modelCount: number;
      windowMinutes?: number;
    }>;
  }>;
};

/**
 * How long an allowance still has to run, in minutes.
 *
 * The provider reports when a window refills, not how long it runs. That is
 * still enough to name the window: a rolling five-hour window has at most five
 * hours left, so a reset under six hours out is one, and anything past five days
 * is the weekly window. The quota consumer uses this to label the row and to
 * tell two windows of the same account apart.
 */
function windowMinutes(resetTime: string | undefined): number | undefined {
  if (!resetTime) return undefined;
  const at = Date.parse(resetTime);
  if (!Number.isFinite(at)) return undefined;
  const remainingMinutes = (at - Date.now()) / 60_000;
  if (remainingMinutes <= 0) return undefined;
  return Math.round(remainingMinutes);
}

function toPercent(fraction: number | undefined): number {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(Math.max(fraction, 0), 1) * 1000) / 10;
}

function toAccount(result: AccountQuotaResult): AntigravityQuotaOutput["accounts"][number] {
  const rawGroups = result.quota?.groups ?? {};
  const groups: AntigravityQuotaOutput["accounts"][number]["groups"] = [];

  // One row per window rather than per family, because a family can run on more
  // than one at a time and a single row can only say what is left on one of them.
  // A family with a five-hour window and a weekly one therefore produces two rows
  // that share a label and differ by when they refill.
  for (const id of Object.keys(rawGroups) as QuotaGroup[]) {
    const summary = rawGroups[id];
    if (!summary) continue;
    for (const window of summary.windows) {
      const minutes = windowMinutes(window.resetTime);
      groups.push({
        id,
        label: GROUP_LABELS[id] ?? id,
        remainingPercent: toPercent(window.remainingFraction),
        ...(window.resetTime ? { resetTime: window.resetTime } : {}),
        ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
        modelCount: window.modelCount,
      });
    }
  }


  return {
    index: result.index,
    ...(result.email ? { email: result.email } : {}),
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
    enabled: result.disabled !== true,
    ...(result.subscription ? { subscription: result.subscription } : {}),
    groups,
  };
}

/**
 * Builds the `antigravity.quota` handler.
 *
 * The handler reads the account pool and asks the existing quota engine for a
 * fresh reading. It does not persist quota caches, so a consumer cannot change
 * what the plugin reports.
 *
 * The one thing it does write back is the managed project id that project
 * resolution just discovered. Resolving it costs several seconds, and it is
 * derived from the account itself, so leaving it in memory meant every later
 * read paid the same cost again. The CLI menu already persists exactly this
 * field, so writing it here keeps the file consistent with that path rather
 * than inventing a second one.
 */
export function createAntigravityQuotaHandler(client: PluginClient) {
  return async function quota(): Promise<AntigravityQuotaOutput> {
    const storage = await loadAccounts();
    const accounts = storage?.accounts ?? [];

    if (accounts.length === 0) {
      return { available: false, reason: "No Antigravity accounts connected", accounts: [] };
    }

    const results = await checkAccountsQuota(accounts, client, ANTIGRAVITY_PROVIDER_ID);

    if (storage) {
      let changed = false;
      for (const result of results) {
        const updated = result.updatedAccount;
        const current = storage.accounts[result.index];
        if (!updated || !current) continue;
        storage.accounts[result.index] = { ...current, ...updated };
        changed = true;
      }
      if (changed) {
        // Best effort: a failed write only costs the slower lookup next time.
        await saveAccounts(storage).catch(() => {});
      }
    }

    return { available: true, accounts: results.map(toAccount) };
  };
}
