/**
 * Transport-aware stream factory selection.
 *
 * Routes models that need OpenClaw-managed proxy/TLS/local-service semantics onto built-in transport implementations.
 */
import type { Api, Model, StreamFn } from "@openclaw/llm-core";
import type { ModelRequestBindingLeafSupport } from "../api-registry.js";
import { getAiTransportHost } from "../host.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { OPENAI_RESPONSES_APIS } from "./openai-responses-contracts.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-transport.js";
import { resolveOpencodeSessionHeaders } from "./session-affinity.js";

const SIMPLE_TRANSPORT_API_ALIAS: Record<string, Api> = {
  "openai-completions": "openclaw-openai-completions-transport",
  "anthropic-messages": "openclaw-anthropic-messages-transport",
  "google-generative-ai": "openclaw-google-generative-ai-transport",
};

type ProviderTransportStreamContext = {
  cfg?: unknown;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

function createProviderOwnedGoogleTransportStreamFn(
  model: Model,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  const streamFn =
    getAiTransportHost().plugin.resolveProviderStream({
      provider: model.provider,
      config: ctx?.cfg,
      workspaceDir: ctx?.workspaceDir,
      env: ctx?.env,
      context: {
        config: ctx?.cfg,
        agentDir: ctx?.agentDir,
        workspaceDir: ctx?.workspaceDir,
        provider: model.provider,
        modelId: model.id,
        model,
      },
    }) ??
    getAiTransportHost().plugin.resolveProviderStream({
      provider: "google",
      config: ctx?.cfg,
      workspaceDir: ctx?.workspaceDir,
      env: ctx?.env,
      context: {
        config: ctx?.cfg,
        agentDir: ctx?.agentDir,
        workspaceDir: ctx?.workspaceDir,
        provider: model.provider,
        modelId: model.id,
        model,
      },
    }) ??
    undefined;
  return streamFn
    ? (requestModel, context, options) =>
        streamFn(requestModel, context, {
          ...options,
          headers: resolveOpencodeSessionHeaders(requestModel, options),
        })
    : undefined;
}

const sseModelRequestBinding: ModelRequestBindingLeafSupport = Object.freeze({
  contract: "wire-model-v1",
  transports: Object.freeze(["sse"] as const),
});

type TransportDescriptor = Readonly<{
  create: (model: Model, ctx?: ProviderTransportStreamContext) => StreamFn | undefined;
  modelRequestBindingSupport?: ModelRequestBindingLeafSupport;
}>;

// Selection and secret-free support inspection share the exact implementation owner.
const transportDescriptors: Readonly<Partial<Record<Api, TransportDescriptor>>> = Object.freeze({
  "openai-responses": {
    create: createOpenAIResponsesTransportStreamFn,
    modelRequestBindingSupport: sseModelRequestBinding,
  },
  "openai-chatgpt-responses": { create: createOpenAIResponsesTransportStreamFn },
  "openai-completions": {
    create: createOpenAICompletionsTransportStreamFn,
    modelRequestBindingSupport: sseModelRequestBinding,
  },
  "azure-openai-responses": {
    create: createAzureOpenAIResponsesTransportStreamFn,
    modelRequestBindingSupport: sseModelRequestBinding,
  },
  "anthropic-messages": { create: createAnthropicMessagesTransportStreamFn },
  "google-generative-ai": { create: createProviderOwnedGoogleTransportStreamFn },
});

function readTransportDescriptor(api: Api): TransportDescriptor | undefined {
  return Object.hasOwn(transportDescriptors, api) ? transportDescriptors[api] : undefined;
}

export function readTransportModelRequestBindingSupport(
  model: Pick<Model, "api">,
): ModelRequestBindingLeafSupport | undefined {
  return readTransportDescriptor(model.api)?.modelRequestBindingSupport;
}

function createSupportedTransportStreamFn(
  model: Model,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  return readTransportDescriptor(model.api)?.create(model, ctx);
}

function hasOpenClawTransportRequirement(model: Model): boolean {
  return getAiTransportHost().requiresManagedTransport(model);
}

/** Returns whether OpenClaw has a managed transport implementation for this API. */
export function isTransportAwareApiSupported(api: Api): boolean {
  return readTransportDescriptor(api) !== undefined;
}

/** Maps public model APIs to the internal transport API id used by simple runtime dispatch. */
export function resolveTransportAwareSimpleApi(api: Api): Api | undefined {
  if (OPENAI_RESPONSES_APIS.has(api)) {
    const alias = `openclaw-${api}-transport` as Api;
    return OPENAI_RESPONSES_APIS.has(alias) ? alias : undefined;
  }
  return SIMPLE_TRANSPORT_API_ALIAS[api];
}

/** Creates a managed transport stream only when request overrides require it. */
export function createTransportAwareStreamFnForModel(
  model: Model,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  if (!hasOpenClawTransportRequirement(model)) {
    return undefined;
  }
  if (!isTransportAwareApiSupported(model.api)) {
    throw new Error(
      `Model-provider request.proxy/request.tls/localService is not yet supported for api "${model.api}"`,
    );
  }
  const streamFn = createSupportedTransportStreamFn(model, ctx);
  if (!streamFn) {
    throw new Error(`Managed transport stream is unavailable for api "${model.api}"`);
  }
  return streamFn;
}

/** Creates a managed OpenClaw transport stream for explicit fallback/runtime callers. */
export function createOpenClawTransportStreamFnForModel(
  model: Model,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  // Explicit fallback callers use this when they need OpenClaw's HTTP
  // transport semantics regardless of the default embedded-runner strategy.
  // Native OpenAI HTTP still depends on this path for strict tool shaping,
  // attribution, cache-boundary stripping, and runtime credential injection.
  if (!isTransportAwareApiSupported(model.api)) {
    return undefined;
  }
  return createSupportedTransportStreamFn(model, ctx);
}

export function createBoundaryAwareStreamFnForModel(
  model: Model,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  // Default embedded-runner fallback. Keep OpenAI-family APIs here while native
  // HTTP streams preserve the same OpenClaw request contract.
  if (!isTransportAwareApiSupported(model.api)) {
    return undefined;
  }
  return createSupportedTransportStreamFn(model, ctx);
}

export function prepareTransportAwareSimpleModel<TApi extends Api>(
  model: Model<TApi>,
  ctx?: ProviderTransportStreamContext,
): Model {
  const streamFn = createTransportAwareStreamFnForModel(model as Model, ctx);
  const alias = resolveTransportAwareSimpleApi(model.api);
  if (!streamFn || !alias) {
    return model;
  }
  return getAiTransportHost().inheritManagedTransport(model, {
    ...model,
    api: alias,
  });
}

export function buildTransportAwareSimpleStreamFn(
  model: Model,
  ctx?: ProviderTransportStreamContext,
): StreamFn | undefined {
  return createTransportAwareStreamFnForModel(model, ctx);
}
