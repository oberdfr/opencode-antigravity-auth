import { Integration, Model, Provider } from "@opencode/plugin";
import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import type { OpencodeModelDefinition } from "./config/models";

const OAUTH_METHOD_ID = "antigravity";

export async function completeOAuth(
  resultPromise: Promise<AntigravityTokenExchangeResult>,
): Promise<{
  type: "oauth";
  methodID: Integration.MethodID;
  refresh: string;
  access: string;
  expires: number;
  metadata: Record<string, unknown>;
}> {
  const result = await resultPromise;
  if (result.type !== "success") throw new Error(result.error);
  return {
    type: "oauth",
    methodID: Integration.MethodID.make(OAUTH_METHOD_ID),
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    metadata: {
      ...(result.email ? { email: result.email } : {}),
      ...(result.projectId ? { projectId: result.projectId } : {}),
    },
  };
}

export function toV2Model(
  providerID: Provider.ID,
  id: string,
  definition: OpencodeModelDefinition,
): Model.Info {
  const model = Model.Info.default(providerID, Model.ID.make(id));
  return {
    ...model,
    name: definition.name,
    limit: definition.limit,
    capabilities: {
      tools: true,
      input: definition.modalities.input,
      output: definition.modalities.output,
    },
    variants: Object.entries(definition.variants ?? {}).map(([variantID, variant]) => ({
      id: Model.VariantID.make(variantID),
      settings: {
        ...(variant.thinkingLevel ? { thinkingLevel: variant.thinkingLevel } : {}),
        ...(variant.thinkingConfig ? { thinkingConfig: variant.thinkingConfig } : {}),
      },
    })),
  };
}
