/**
 * The Antigravity request envelope's identity fields.
 *
 * Cloud Code Assist does not just want a session id: it wants the one shape the real
 * Antigravity client sends, and the rest of the envelope identifies a trajectory
 * through it. A session id that is a composite string is accepted and then treated as
 * something it does not recognise, and the request comes back behaving differently from
 * how the same thinking settings do through the proper identity.
 *
 * Mirrors the shape used by the reference implementation:
 *
 *   sessionId   signed decimal, stable for the conversation
 *   requestId   agent/<agentId>/<timestamp>/<trajectoryId>/<step>
 *   labels      step and trajectory, plus which family the model belongs to
 *
 * Everything is derived from the conversation, so the same conversation keeps the same
 * identity across turns and a new one starts a new trajectory. Nothing here is random
 * at request time, which is what makes it stable.
 */

import { createHash } from "node:crypto";

/** Largest signed 63-bit value, the range a session id is drawn from. */
const INT63_MASK = (1n << 63n) - 1n;

/** Digests a stable string into a signed decimal session id. */
function signedDecimalFromHash(text: string): string {
  const digest = createHash("sha256").update(text).digest();
  let value = 0n;
  for (let index = 0; index < 8; index++) {
    value = (value << 8n) | BigInt(digest[index] ?? 0);
  }
  return `-${(value & INT63_MASK).toString()}`;
}

/** Digests a stable string into a UUID, for the agent and trajectory identities. */
function uuidFromHash(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Steps issued per conversation, so each request advances the counter. */
const stepByConversation = new Map<string, number>();

/** Cap on remembered conversations, so a long-lived process cannot grow without bound. */
const MAX_TRACKED_CONVERSATIONS = 500;

export interface AntigravityIdentity {
  /** Signed decimal session id, stable for the conversation. */
  sessionId: string;
  /** `agent/<agentId>/<timestamp>/<trajectoryId>/<step>` */
  requestId: string;
  /** Labels carried on the request, mirroring the real client's. */
  labels: Record<string, string>;
}

/**
 * Builds the identity for one request.
 *
 * @param conversation Stable key for the conversation: model, project and turn identity.
 * @param isClaude      Whether the model belongs to the Claude family.
 * @param lastExecutionId Response id of the previous step, echoed back when known.
 */
export function antigravityIdentity(
  conversation: string,
  isClaude: boolean,
  lastExecutionId?: string,
): AntigravityIdentity {
  const step = (stepByConversation.get(conversation) ?? 1) + 1;
  stepByConversation.set(conversation, step);

  if (stepByConversation.size > MAX_TRACKED_CONVERSATIONS) {
    for (const key of stepByConversation.keys()) {
      if (stepByConversation.get(key) === step) stepByConversation.delete(key);
      if (stepByConversation.size <= MAX_TRACKED_CONVERSATIONS) break;
    }
  }

  const agentId = uuidFromHash(`${conversation}:agent`);
  const trajectoryId = uuidFromHash(`${conversation}:trajectory`);
  const usageLabel = String(isClaude);

  const labels: Record<string, string> = {
    last_step_index: String(step - 1),
    trajectory_id: trajectoryId,
    used_claude: usageLabel,
    used_claude_conservative: usageLabel,
  };
  if (lastExecutionId) labels.last_execution_id = lastExecutionId;

  return {
    sessionId: signedDecimalFromHash(conversation),
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
    labels,
  };
}

/** Forgets the step counter for a conversation, so a fresh one starts from the beginning. */
export function resetAntigravityConversation(conversation: string): void {
  stepByConversation.delete(conversation);
}