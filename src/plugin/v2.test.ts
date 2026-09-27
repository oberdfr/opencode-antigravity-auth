import { describe, expect, it } from "vitest";
import { Provider } from "@opencode/plugin";
import { completeOAuth, toV2Model } from "./v2-adapters";
import { OPENCODE_MODEL_DEFINITIONS } from "./config/models";

describe("V2 OAuth adapter", () => {
  it("converts a successful token exchange into a V2 OAuth credential", async () => {
    const credential = await completeOAuth(
      Promise.resolve({
        type: "success",
        refresh: "refresh-token",
        access: "access-token",
        expires: 123456,
        email: "user@example.com",
        projectId: "project-123",
      }),
    );

    expect(credential).toEqual({
      type: "oauth",
      methodID: "antigravity",
      refresh: "refresh-token",
      access: "access-token",
      expires: 123456,
      metadata: { email: "user@example.com", projectId: "project-123" },
    });
  });

  it("omits optional metadata when the token exchange has no email", async () => {
    const credential = await completeOAuth(
      Promise.resolve({
        type: "success",
        refresh: "refresh-token",
        access: "access-token",
        expires: 123456,
        projectId: "project-123",
      }),
    );

    expect(credential.metadata).toEqual({ projectId: "project-123" });
  });

  it("propagates failed token exchanges", async () => {
    await expect(completeOAuth(Promise.resolve({ type: "failed", error: "OAuth failed" }))).rejects.toThrow(
      "OAuth failed",
    );
  });
});

describe("V2 model adapter", () => {
  it("converts model limits, capabilities, and variants into V2 fields", () => {
    const id = "antigravity-gemini-3.8-flash";
    const providerID = Provider.ID.make("google");
    const model = toV2Model(providerID, id, OPENCODE_MODEL_DEFINITIONS[id]!);

    expect(model).toMatchObject({
      id,
      providerID: "google",
      name: "Gemini 3.8 Flash (Antigravity)",
      limit: { context: 1048576, output: 65536 },
      capabilities: {
        tools: true,
        input: ["text", "image", "pdf"],
        output: ["text"],
      },
      variants: [
        { id: "low", settings: { thinkingLevel: "low" } },
        { id: "medium", settings: { thinkingLevel: "medium" } },
        { id: "high", settings: { thinkingLevel: "high" } },
      ],
    });
  });

  it("represents models without variants as an empty V2 variants list", () => {
    const id = "antigravity-claude-sonnet-4-6";
    const model = toV2Model(Provider.ID.make("google"), id, OPENCODE_MODEL_DEFINITIONS[id]!);

    expect(model.variants).toEqual([]);
  });
});
