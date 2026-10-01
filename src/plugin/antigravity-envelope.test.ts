/**
 * The identity fields on the Antigravity envelope.
 *
 * Cloud Code Assist is sent a session id, a request id and a set of labels, and the
 * session id has a shape: signed decimal, stable for the conversation. A composite string
 * is accepted and then not recognised as a trajectory, so the gateway answers as though
 * the conversation were new. That is invisible in a response that still returns text, and
 * it is the difference between a thinking summary belonging to its turn and one that does
 * not.
 *
 * Everything is derived from the conversation, so the shape can be checked exactly.
 */

import { describe, expect, it } from "vitest";
import {
  antigravityIdentity,
  resetAntigravityConversation,
} from "./antigravity-envelope";

const signedDecimal = /^-\d+$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("the session id", () => {
  it("is signed decimal, which is the shape the gateway recognises", () => {
    const identity = antigravityIdentity("conversation-a:model:project", false);

    expect(identity.sessionId).toMatch(signedDecimal);
  });

  it("stays the same across the turns of one conversation", () => {
    // Stability is the point: a new id per request would make every turn look like a new
    // conversation to the gateway.
    const first = antigravityIdentity("conversation-b:model:project", false).sessionId;
    const second = antigravityIdentity("conversation-b:model:project", false).sessionId;
    const third = antigravityIdentity("conversation-b:model:project", false).sessionId;

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("differs between conversations", () => {
    expect(antigravityIdentity("one:model:project", false).sessionId).not.toBe(
      antigravityIdentity("two:model:project", false).sessionId,
    );
  });

  it("fits a signed 63-bit value, so it cannot overflow the field", () => {
    const value = BigInt(antigravityIdentity("range:model:project", false).sessionId.slice(1));
    const limit = (1n << 63n) - 1n;

    expect(value).toBeLessThanOrEqual(limit);
    expect(value).toBeGreaterThan(0n);
  });
});

describe("the request id", () => {
  it("names the agent, the moment, the trajectory and the step", () => {
    const identity = antigravityIdentity("req:model:project", false);
    const parts = identity.requestId.split("/");

    expect(parts[0]).toBe("agent");
    expect(parts[1]).toMatch(uuid);
    expect(Number(parts[2])).toBeGreaterThan(0);
    expect(parts[3]).toMatch(uuid);
    expect(Number(parts[4])).toBeGreaterThan(0);
  });

  it("advances the step on each request of a conversation", () => {
    const conversation = "steps:model:project";
    const stepOf = () => antigravityIdentity(conversation, false).requestId.split("/")[4]!;
    const first = Number(stepOf());

    const steps = [first, Number(stepOf()), Number(stepOf())];

    expect(steps).toEqual([first, first + 1, first + 2]);
  });

  it("starts over for a conversation that has been reset", () => {
    const conversation = "reset:model:project";
    const before = antigravityIdentity(conversation, false).requestId;

    resetAntigravityConversation(conversation);
    const after = antigravityIdentity(conversation, false).requestId;

    expect(Number(after.split("/")[4])).toBe(2);
    expect(Number(before.split("/")[4])).toBe(2);
  });
});

describe("the labels", () => {
  it("trail the request by one step, as the gateway expects", () => {
    const identity = antigravityIdentity("labels:model:project", false);
    const step = Number(identity.requestId.split("/")[4]);

    expect(identity.labels.last_step_index).toBe(String(step - 1));
  });

  it("name the trajectory the request id carries", () => {
    const identity = antigravityIdentity("traj:model:project", false);

    expect(identity.labels.trajectory_id).toBe(identity.requestId.split("/")[3]);
  });

  it("say which family the model belongs to, on both fields", () => {
    expect(antigravityIdentity("claude:model:project", true).labels).toMatchObject({
      used_claude: "true",
      used_claude_conservative: "true",
    });
    expect(antigravityIdentity("gemini:model:project", false).labels).toMatchObject({
      used_claude: "false",
      used_claude_conservative: "false",
    });
  });

  it("echo the previous response id back only when there is one", () => {
    expect(antigravityIdentity("first:model:project", false).labels.last_execution_id).toBeUndefined();
    expect(
      antigravityIdentity("second:model:project", false, "resp-42").labels.last_execution_id,
    ).toBe("resp-42");
  });
});