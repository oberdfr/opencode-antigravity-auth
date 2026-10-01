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
    variants: Object.entries(definition.variants ?? {}).map(([variantID, variant]) => {
      // The thinking config a Gemini 3 variant asks for, in the shape Google's own
      // request builder reads.
      const thinkingConfig = variant.thinkingConfig ?? (
        variant.thinkingLevel
          ? { includeThoughts: true, thinkingLevel: variant.thinkingLevel }
          : undefined
      );

      return {
        id: Model.VariantID.make(variantID),
        // Both channels, because neither alone reaches the request.
        //
        // `settings` is what a variant is expected to carry and what OpenCode reads to
        // decide a variant is applicable. `body` is what it actually merges into the
        // outgoing request. Declaring only settings produced a variant the UI listed
        // and accepted while the request it built contained no thinking config at all,
        // so choosing a thinking level changed nothing about whether the model thought.
        //
        // The body patch is what makes the choice real, and it is kept identical to the
        // settings form so the two can never disagree about what was asked for.
        settings: thinkingConfig ? { thinkingConfig } : {},
        ...(thinkingConfig?.thinkingLevel
          ? {
              body: {
                generationConfig: {
                  thinkingConfig: {
                    includeThoughts: thinkingConfig.includeThoughts ?? true,
                    thinkingLevel: thinkingConfig.thinkingLevel,
                  },
                },
              },
            }
          : {}),
      };
    }),
  };
}
