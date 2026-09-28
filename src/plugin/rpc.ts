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

const quotaGroupSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    remainingPercent: { type: "number" },
    resetTime: { type: "string" },
    modelCount: { type: "number" },
  },
  required: ["id", "label", "remainingPercent", "modelCount"],
  additionalProperties: false,
} as const;

const geminiCliModelSchema = {
  type: "object",
  properties: {
    modelId: { type: "string" },
    remainingPercent: { type: "number" },
    resetTime: { type: "string" },
  },
  required: ["modelId", "remainingPercent"],
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
    groups: { type: "array", items: quotaGroupSchema },
    geminiCli: { type: "array", items: geminiCliModelSchema },
    geminiCliError: { type: "string" },
  },
  required: ["index", "status", "enabled", "groups", "geminiCli"],
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
    groups: Array<{
      id: string;
      label: string;
      remainingPercent: number;
      resetTime?: string;
      modelCount: number;
    }>;
    geminiCli: Array<{ modelId: string; remainingPercent: number; resetTime?: string }>;
    geminiCliError?: string;
  }>;
};

function toPercent(fraction: number | undefined): number {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(Math.max(fraction, 0), 1) * 1000) / 10;
}

function toAccount(result: AccountQuotaResult): AntigravityQuotaOutput["accounts"][number] {
  const rawGroups = result.quota?.groups ?? {};
  const groups: AntigravityQuotaOutput["accounts"][number]["groups"] = [];

  for (const id of Object.keys(rawGroups) as QuotaGroup[]) {
    const summary = rawGroups[id];
    if (!summary) continue;
    groups.push({
      id,
      label: GROUP_LABELS[id] ?? id,
      remainingPercent: toPercent(summary.remainingFraction),
      ...(summary.resetTime ? { resetTime: summary.resetTime } : {}),
      modelCount: summary.modelCount,
    });
  }

  const geminiCli = (result.geminiCliQuota?.models ?? []).map((model) => ({
    modelId: model.modelId,
    remainingPercent: toPercent(model.remainingFraction),
    ...(model.resetTime ? { resetTime: model.resetTime } : {}),
  }));

  return {
    index: result.index,
    ...(result.email ? { email: result.email } : {}),
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
    enabled: result.disabled !== true,
    groups,
    geminiCli,
    ...(result.geminiCliQuota?.error ? { geminiCliError: result.geminiCliQuota.error } : {}),
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
