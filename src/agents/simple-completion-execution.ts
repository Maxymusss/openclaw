/** Executes an already-prepared model without importing model/auth preparation. */
import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import {
  prepareHeadersForSimpleCompletion,
  prepareModelForSimpleCompletion,
} from "@openclaw/ai/transports";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bindModelLlmRuntime,
  getModelCompletionOwner,
  getModelCompletionTransport,
  getModelLlmRuntime,
} from "../llm/model-runtime-binding.js";
import { completeSimple } from "../llm/stream.js";
import type { AssistantMessage, Model, SimpleStreamOptions } from "../llm/types.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import type { ResolvedProviderAuth } from "./model-auth.js";
import {
  assertOperatorModelAllowed,
  assertOperatorModelResponse,
  runWithOperatorModelAuthority,
  runWithOperatorModelRequest,
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
    const owner = getModelCompletionOwner(params.model);
    // SDK ownership can replace the ambient work scope. Retain inside it so
    // accepted provider callbacks and cleanup keep this source until they drain.
    const run = () =>
      runWithOperatorModelAuthority(operatorAuthority, async () => {
        const result = await completePreparedModel({
          ...params,
          operatorAuthority,
          assertCurrent: owner
            ? () => {
                owner.assertCurrent();
                params.assertCurrent?.();
              }
            : params.assertCurrent,
        });
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
  let completionModel =
    getModelCompletionTransport(params.model) ??
    prepareModelForSimpleCompletion({
      // Direct SDK callers that did not use the preparation helper keep the shipped
      // process-default behavior; all prepared host paths carry their lifecycle owner.
      apiRegistry: runtime?.registry ?? defaultApiRegistry,
      model: params.model,
      cfg: params.cfg,
    });
  if (runtime) {
    completionModel = bindModelLlmRuntime(completionModel, runtime);
  }
  const assertCurrent = () => {
    params.assertCurrent?.();
    assertOperatorModelAllowed(
      params.operatorAuthority,
      completionModel.provider,
      completionModel.id,
    );
  };
  assertCurrent();
  const { reasoning: rawReasoning, strictReasoningTags, ...options } = params.options ?? {};
  const reasoning =
    rawReasoning === "adaptive" ? "medium" : rawReasoning === "ultra" ? "max" : rawReasoning;
  const headers = prepareHeadersForSimpleCompletion(completionModel, options);
  const completionOptions: SimpleStreamOptions = {
    ...options,
    ...(reasoning ? { reasoning } : {}),
    apiKey: params.auth.apiKey,
    ...(headers ? { headers } : {}),
  };
  if (strictReasoningTags) {
    reasoningTagTextPolicy.markStrict(completionOptions);
  }
  return await completeSimple(completionModel, params.context, completionOptions, assertCurrent);
}
