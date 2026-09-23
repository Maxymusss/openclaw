/** Executes an already-prepared model without importing model/auth preparation. */
import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import {
  prepareHeadersForSimpleCompletion,
  prepareModelForSimpleCompletion,
} from "@openclaw/ai/transports";
import { resolveProviderThinkingLevel, type ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bindModelLlmRuntime,
  bindModelRequestRoute,
  readModelRequestRoute,
  getModelCompletionOwner,
  getModelCompletionTransport,
  getModelCompletionTransportKind,
  getModelLlmRuntime,
} from "../llm/model-runtime-binding.js";
import { completeSimple } from "../llm/stream.js";
import type { AssistantMessage, Model, SimpleStreamOptions } from "../llm/types.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import {
  resolvePreparedExtraParams,
  resolveSupportedTransport,
} from "./embedded-agent-runner/extra-params.js";
import type { ResolvedProviderAuth } from "./model-auth.js";
import {
  assertOperatorModelRequestRoute,
  assertOperatorModelSelection,
  OperatorModelPolicyError,
  assertOperatorModelResponse,
  runWithOperatorModelAuthority,
  runWithOperatorModelRequest,
  runWithOperatorModelSelection,
} from "./operator-model-policy.js";

type SimpleCompletionModelOptions = {
  headers?: Record<string, string>;
  sessionId?: string;
  maxTokens?: number;
  temperature?: number;
  serviceTier?: SimpleStreamOptions["serviceTier"];
  reasoning?: ThinkLevel;
  strictReasoningTags?: boolean;
  signal?: AbortSignal;
};

type PreparedCompletionParams = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  assertCurrent?: () => void;
  model: Model;
  auth: ResolvedProviderAuth;
  context: Parameters<typeof completeSimple>[1];
  cfg?: OpenClawConfig;
  options?: SimpleCompletionModelOptions;
};

export async function completeWithPreparedSimpleCompletionModel(
  params: PreparedCompletionParams,
): Promise<AssistantMessage> {
  return await runWithOperatorModelRequest(params.operatorAuthority, async (operatorAuthority) => {
    const model =
      !operatorAuthority?.modelPolicy || readModelRequestRoute(params.model)
        ? params.model
        : bindModelRequestRoute(params.model, {
            provider: params.model.provider,
            model: params.model.id,
          });
    const owner = getModelCompletionOwner(model);
    // SDK ownership can replace the ambient work scope. Retain inside it so
    // accepted provider callbacks and cleanup keep this source until they drain.
    const run = () =>
      runWithOperatorModelAuthority(operatorAuthority, async () => {
        const result = await runWithOperatorModelSelection(operatorAuthority, model, () =>
          completePreparedModel({
            ...params,
            model,
            operatorAuthority,
            assertCurrent: owner
              ? () => {
                  owner.assertCurrent();
                  params.assertCurrent?.();
                }
              : params.assertCurrent,
          }),
        );
        assertOperatorModelResponse(result);
        return result;
      });
    return owner ? await owner.run(run) : await run();
  });
}

async function completePreparedModel(params: PreparedCompletionParams): Promise<AssistantMessage> {
  // Direct SDK calls prepare transport hooks before entering the stream facade.
  await import("./ai-transport-runtime-host.js");
  params.assertCurrent?.();
  params.options?.signal?.throwIfAborted();
  const runtime = getModelLlmRuntime(params.model);
  const transport =
    getModelCompletionTransportKind(params.model) ??
    resolveSupportedTransport(
      resolvePreparedExtraParams({
        cfg: params.cfg,
        provider: params.model.provider,
        modelId: params.model.id,
        model: params.model,
      }).transport,
    );
  let completionModel =
    getModelCompletionTransport(params.model) ??
    prepareModelForSimpleCompletion({
      // Direct SDK callers that did not use the preparation helper keep the shipped
      // process-default behavior; all prepared host paths carry their lifecycle owner.
      apiRegistry: runtime?.registry ?? defaultApiRegistry,
      model: params.model,
      cfg: params.cfg,
      transport,
    });
  if (runtime) {
    completionModel = bindModelLlmRuntime(completionModel, runtime);
  }
  if (
    params.operatorAuthority?.modelPolicy &&
    readModelRequestRoute(completionModel)?.logicalRef !==
      readModelRequestRoute(params.model)?.logicalRef
  ) {
    throw new OperatorModelPolicyError("The transport replaced the prepared model selection.");
  }
  return await runWithOperatorModelSelection(
    params.operatorAuthority,
    completionModel,
    async () => {
      const assertCurrent = () => {
        params.assertCurrent?.();
        assertOperatorModelSelection(params.operatorAuthority, params.model);
        assertOperatorModelRequestRoute(params.operatorAuthority, completionModel);
      };
      assertCurrent();
      const { reasoning: rawReasoning, strictReasoningTags, ...options } = params.options ?? {};
      const providerReasoning = resolveProviderThinkingLevel({
        provider: completionModel.provider,
        model: completionModel.id,
        catalog: [completionModel],
        agentRuntime: "openclaw",
        level: rawReasoning,
      });
      const reasoning = providerReasoning === "adaptive" ? "medium" : providerReasoning;
      const headers = prepareHeadersForSimpleCompletion(completionModel, options);
      const completionOptions: SimpleStreamOptions = {
        ...options,
        ...(transport ? { transport } : {}),
        ...(reasoning ? { reasoning } : {}),
        apiKey: params.auth.apiKey,
        ...(headers ? { headers } : {}),
      };
      if (strictReasoningTags) {
        reasoningTagTextPolicy.markStrict(completionOptions);
      }
      return await completeSimple(
        completionModel,
        params.context,
        completionOptions,
        assertCurrent,
      );
    },
  );
}
