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
import { loadAccounts } from "./storage";
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
 * The handler only reads: it loads the account pool and asks the existing quota
 * engine for a fresh reading. It deliberately does not persist quota caches or
 * rotated refresh tokens, so the quota consumer cannot change plugin behaviour.
 */
export function createAntigravityQuotaHandler(client: PluginClient) {
  return async function quota(): Promise<AntigravityQuotaOutput> {
    const storage = await loadAccounts();
    const accounts = storage?.accounts ?? [];

    if (accounts.length === 0) {
      return { available: false, reason: "No Antigravity accounts connected", accounts: [] };
    }

    const results = await checkAccountsQuota(accounts, client, ANTIGRAVITY_PROVIDER_ID);
    return { available: true, accounts: results.map(toAccount) };
  };
}
