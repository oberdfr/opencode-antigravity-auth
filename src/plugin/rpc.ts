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
import { loadAccounts, saveAccounts, type AccountMetadataV3 } from "./storage";
import { eligibleAccounts, type AccountSelection, type AccountTier } from "./selection";
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
    // Absent until a quota reading has established it. Declared because the schema
    // forbids extra properties, so an undeclared field is stripped from the response.
    tier: { type: "string", enum: ["pro", "free"] },
    groups: { type: "array", items: quotaGroupSchema },
  },
  required: ["index", "status", "enabled", "groups"],
  additionalProperties: false,
} as const;

/**
 * One account as the selection surface reports it.
 *
 * Carries the tier because "which of these do I want" and "which of these are paid" are
 * the same question to the person answering it, and making them ask twice by opening
 * quota separately is how a free account ends up pinned first.
 */
const selectableAccountSchema = {
  type: "object",
  properties: {
    index: { type: "number" },
    email: { type: "string" },
    tier: { type: "string", enum: ["pro", "free"] },
    enabled: { type: "boolean" },
    /** Whether this account is inside the current selection. */
    selected: { type: "boolean" },
  },
  required: ["index", "enabled", "selected"],
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
    /**
     * Reads and changes which accounts requests may use.
     *
     * Separate from `quota` because the two answer different questions and have very
     * different costs: reading the selection is a file read, while reading quota is a
     * token refresh and two round trips per account. A menu that lists accounts to
     * choose from should not be paying for a quota read on every keystroke.
     */
    selection: {
      input: {
        type: "object",
        properties: {
          /**
           * Accounts to use, or empty to use every account.
           *
           * Absent reads the selection without changing it, which is how the same
           * method serves both halves: a caller that only wants to look passes nothing.
           */
          emails: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          accounts: { type: "array", items: selectableAccountSchema },
          /** Empty when every account is eligible. */
          pinnedEmails: { type: "array", items: { type: "string" } },
          /** Emails named in the request that are not in the pool, and were dropped. */
          unknown: { type: "array", items: { type: "string" } },
        },
        required: ["accounts", "pinnedEmails"],
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
    tier?: AccountTier;
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

export type AntigravitySelectionOutput = {
  /**
   * The pool in the order requests will prefer it: paid accounts first, then by
   * position. The array index is therefore the preference order, not the account's
   * slot in the pool, which is what lets a menu render it top-down as the order.
   */
  accounts: Array<{
    index: number;
    email?: string;
    tier?: AccountTier;
    enabled: boolean;
    selected: boolean;
  }>;
  pinnedEmails: string[];
  unknown?: string[];
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
    // Reported so a consumer can show paid and free apart without inferring it from the
    // window shape, which is the same inference this handler would otherwise force on
    // whoever is reading the output.
    ...(result.tier ? { tier: result.tier } : {}),
    groups,
  };
}

/**
 * Builds the `antigravity.selection` handler.
 *
 * Reads the pool from disk and writes the selection back to the same file the account
 * manager loads from, so there is one source of truth: a change made here is the same
 * change the menu would have made, and the next request picks it up whether the
 * manager was already loaded or not.
 *
 * An empty `emails` list means every account. That is the same shape the stored
 * selection uses, so "no selection" and "select everything" do not need two encodings
 * that could disagree.
 */
export function createAntigravitySelectionHandler() {
  return async function selection(input?: unknown): Promise<AntigravitySelectionOutput> {
    const storage = await loadAccounts();
    const accounts = storage?.accounts ?? [];
    const requested = readRequestedEmails(input);

    if (requested === undefined) {
      return toSelectionOutput(accounts, storage?.selection ?? { pinnedEmails: [] }, []);
    }

    const known = new Set(accounts.map((account) => account.email));
    const cleaned = requested.map((email) => email.trim()).filter((email) => email.length > 0);
    const unknown = cleaned.filter((email) => !known.has(email));
    // Deduplicated and sorted so the same choice written twice produces the same file,
    // rather than accumulating whatever order two callers happened to use.
    const pinnedEmails = [...new Set(cleaned.filter((email) => known.has(email)))].sort();

    const next: AccountSelection = { pinnedEmails };

    if (storage) {
      await saveAccounts({ ...storage, selection: next }).catch(() => {});
    }

    return toSelectionOutput(accounts, next, unknown);
  };
}

/**
 * Reads the requested emails out of an untyped RPC argument.
 *
 * Returns undefined for "not supplied", which is the read case. Anything present but
 * not a list of strings is treated the same way rather than throwing, so a malformed
 * call reports the current selection instead of failing the request that made it.
 */
function readRequestedEmails(input: unknown): string[] | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const emails = (input as { emails?: unknown }).emails;
  if (emails === undefined) return undefined;
  if (!Array.isArray(emails)) return undefined;
  return emails.filter((email): email is string => typeof email === "string");
}

function toSelectionOutput(
  accounts: AccountMetadataV3[],
  selection: AccountSelection,
  unknown: string[],
): AntigravitySelectionOutput {
  const pinned = new Set(selection.pinnedEmails);
  // The stored rows carry no index of their own, so position is assigned before the
  // ordering pass. It is then the array position in the output that expresses
  // preference, which is what the schema documents.
  const positional = accounts.map((account, index) => ({ ...account, index }));
  return {
    accounts: eligibleAccounts(positional, selection).map((account) => ({
      index: account.index,
      ...(account.email ? { email: account.email } : {}),
      ...(account.tier ? { tier: account.tier } : {}),
      enabled: account.enabled !== false,
      selected: account.email ? pinned.has(account.email) : false,
    })),
    pinnedEmails: [...selection.pinnedEmails],
    ...(unknown.length > 0 ? { unknown } : {}),
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
