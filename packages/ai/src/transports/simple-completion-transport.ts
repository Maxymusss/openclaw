/**
 * Simple completion transport preparation.
 *
 * Registers provider-specific stream functions and rewrites models that need OpenClaw-managed transport semantics.
 */
import { randomUUID } from "node:crypto";
import { inheritModelRequestBinding } from "@openclaw/llm-core";
import type { Api, Model, StreamFn, StreamOptions, SimpleStreamOptions } from "@openclaw/llm-core";
import type { ApiRegistry, ModelRequestBindingLeafSupport } from "../api-registry.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import {
  buildTransportAwareSimpleStreamFn,
  createOpenClawTransportStreamFnForModel,
  createTransportAwareStreamFnForModel,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
  readTransportModelRequestBindingSupport,
} from "./provider-transport-stream.js";
import { resolveOpencodeSessionHeaders } from "./session-affinity.js";

/** Standalone completions have no durable session, but may require routing identity. */
export function prepareHeadersForSimpleCompletion(
  model: Pick<Model, "baseUrl" | "headers">,
  options?: Pick<StreamOptions, "sessionId" | "headers">,
): Record<string, string> | undefined {
  // Keep the synthetic identity in the required header only: a stream sessionId
  // would also enable unrelated cache and WebSocket session ownership.
  return resolveOpencodeSessionHeaders(model, {
    ...options,
    sessionId: options?.sessionId || randomUUID(),
  });
}

const PROVIDER_SIMPLE_COMPLETION_API_PREFIX = "openclaw-provider-simple:";
const PROVIDER_STREAM_API_PREFIX = "openclaw-provider-stream:";
const INVALID_CODEX_BASE_URL_MESSAGE =
  "OpenAI Codex Responses baseUrl must not include query parameters or fragments";

function registerCustomApi(
  registry: ApiRegistry,
  api: Api,
  streamFn: StreamFn,
  support?: ModelRequestBindingLeafSupport,
): boolean {
  getAiTransportHost().registerCustomApi(registry, api, streamFn, support);
  return registry.getApiProvider(api) !== undefined;
}

function projectModel(model: Model, patch: Partial<Model>): Model {
  return getAiTransportHost().inheritManagedTransport(model, { ...model, ...patch });
}

function resolveAnthropicVertexSimpleApi(baseUrl?: string): Api {
  const suffix = baseUrl?.trim() ? encodeURIComponent(baseUrl.trim()) : "default";
  return `openclaw-anthropic-vertex-simple:${suffix}`;
}

export function normalizeCodexResponsesBaseUrlForOpenAISdk(baseUrl?: string): string {
  const normalized = baseUrl?.trim() || "https://chatgpt.com/backend-api";
  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname.replace(/\/+$/u, "");
    const path = pathname.toLowerCase();
    if (
      parsed.hostname.toLowerCase() === "chatgpt.com" &&
      [
        "/backend-api",
        "/backend-api/v1",
        "/backend-api/codex",
        "/backend-api/codex/v1",
        "/backend-api/codex/responses",
      ].includes(path)
    ) {
      parsed.pathname = "/backend-api/codex";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/u, "");
    }
    if (normalized.includes("?") || normalized.includes("#")) {
      throw new Error(INVALID_CODEX_BASE_URL_MESSAGE);
    }
    parsed.pathname = path.endsWith("/codex/responses")
      ? pathname.slice(0, -"/responses".length)
      : path.endsWith("/codex")
        ? pathname
        : `${pathname}/codex`;
    return parsed.toString();
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_CODEX_BASE_URL_MESSAGE) {
      throw error;
    }
    // Keep non-URL custom values on the same suffix contract transport callers accept.
  }
  if (normalized.includes("?") || normalized.includes("#")) {
    throw new Error(INVALID_CODEX_BASE_URL_MESSAGE);
  }
  const path = normalized.replace(/\/+$/u, "");
  if (path.endsWith("/codex/responses")) {
    return path.slice(0, -"/responses".length);
  }
  return path.endsWith("/codex") ? path : `${path}/codex`;
}

function resolveProviderSimpleCompletionApi(model: Model): Api {
  const parts = [model.provider, model.id, model.api, model.baseUrl || "default"];
  return `${PROVIDER_SIMPLE_COMPLETION_API_PREFIX}${parts
    .map((part) => encodeURIComponent(part))
    .join(":")}`;
}

function resolveProviderStreamApi(model: Model): Api {
  const parts = [model.provider, model.id, model.api, model.baseUrl || "default"];
  return `${PROVIDER_STREAM_API_PREFIX}${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

function applyProviderSimpleCompletionWrapper(
  registry: ApiRegistry,
  model: Model,
  cfg?: unknown,
  hookSourceApi: Api = model.api,
  transport?: SimpleStreamOptions["transport"],
  support?: ModelRequestBindingLeafSupport,
): Model {
  if (model.api.startsWith(PROVIDER_SIMPLE_COMPLETION_API_PREFIX)) {
    return model;
  }
  const sourceProvider = registry.getApiProvider(model.api);
  if (!sourceProvider) {
    return model;
  }

  const dispatchApi = model.api;
  const sourceStreamFn = inheritModelRequestBinding<StreamFn>((runtimeModel, context, options) => {
    const policy = getAiTransportHost().modelRequests;
    if (registry.getApiProvider(dispatchApi) !== sourceProvider) {
      policy?.requireDelegateSupport(undefined);
    }
    policy?.requireLeafSupport?.(
      runtimeModel,
      sourceProvider.modelRequestBindingSupport?.streamSimple,
      options?.transport,
    );
    return sourceProvider.streamSimple(
      projectModel(runtimeModel, { api: dispatchApi }),
      context,
      options,
    );
  }, sourceProvider.streamSimple);
  const streamFn = getAiTransportHost().plugin.wrapSimpleCompletionStream({
    provider: model.provider,
    config: cfg,
    preparedTransport: transport,
    context: {
      config: cfg,
      provider: model.provider,
      modelId: model.id,
      model,
      sourceApi: hookSourceApi,
      streamFn: sourceStreamFn,
    },
  });
  if (!streamFn) {
    return model;
  }

  const api = resolveProviderSimpleCompletionApi(model);
  return registerCustomApi(registry, api, streamFn, support) ? projectModel(model, { api }) : model;
}

function prepareCodexSimpleTransportModel<TApi extends Api>(
  registry: ApiRegistry,
  model: Model<TApi>,
  cfg?: unknown,
): Model | undefined {
  if (model.provider !== "openai" || model.api !== "openai-chatgpt-responses") {
    return undefined;
  }

  // Static Codex provider catalogs intentionally omit credentials; the simple
  // completion path must use OpenClaw's transport so resolved request auth is applied.
  const transportModel = projectModel(model, {
    baseUrl: normalizeCodexResponsesBaseUrlForOpenAISdk(model.baseUrl),
  });
  const api = resolveTransportAwareSimpleApi(model.api);
  const streamFn = createOpenClawTransportStreamFnForModel(transportModel, { cfg });
  if (!api || !streamFn) {
    return undefined;
  }

  if (!registerCustomApi(registry, api, streamFn)) {
    return undefined;
  }
  return projectModel(transportModel, { api });
}

function resolveModelTransportSentinels<TApi extends Api>(
  model: Model<TApi>,
  boundary: string,
): Model<TApi> {
  const host = getAiTransportHost();
  if (host.unwrapModelTransportSentinels) {
    return host.unwrapModelTransportSentinels(model, boundary);
  }
  // Partial embedding hosts still own visible headers through the original port.
  const headers = resolveAiTransportHeaderSentinels(model.headers);
  return headers === model.headers ? model : (projectModel(model, { headers }) as Model<TApi>);
}

function wrapPluginProviderStream(streamFn: StreamFn): StreamFn {
  return inheritModelRequestBinding<StreamFn>((model, context, options) => {
    const host = getAiTransportHost();
    const apiKey = options?.apiKey ? host.resolveSecretSentinel(options.apiKey) : options?.apiKey;
    const headers = resolveAiTransportHeaderSentinels(options?.headers);
    return streamFn(
      resolveModelTransportSentinels(model, "plugin simple-completion stream egress"),
      context,
      apiKey === options?.apiKey && headers === options?.headers
        ? options
        : { ...options, apiKey, headers },
    );
  }, streamFn);
}

function prepareProviderStreamModel<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: unknown;
  apiRegistry: ApiRegistry;
  transport?: SimpleStreamOptions["transport"];
  support?: ModelRequestBindingLeafSupport;
}): Model | undefined {
  const pluginModel = resolveModelTransportSentinels(
    params.model,
    "plugin simple-completion stream construction",
  );
  const providerStreamFn = getAiTransportHost().plugin.resolveProviderStream({
    provider: params.model.provider,
    config: params.cfg,
    preparedTransport: params.transport,
    context: {
      config: params.cfg,
      provider: params.model.provider,
      modelId: params.model.id,
      model: pluginModel,
    },
  });
  const transportFallback = providerStreamFn
    ? undefined
    : createTransportAwareStreamFnForModel(
        params.model.api === "google-generative-ai" ? pluginModel : params.model,
        { cfg: params.cfg },
      );
  const streamFn = providerStreamFn
    ? wrapPluginProviderStream(providerStreamFn)
    : transportFallback && params.model.api === "google-generative-ai"
      ? wrapPluginProviderStream(transportFallback)
      : transportFallback;
  if (!streamFn) {
    return undefined;
  }
  // A plugin can own one model while reusing a built-in wire-format id. Keep
  // that stream on a model-specific alias instead of replacing the shared API.
  const api = params.apiRegistry.getApiProvider(params.model.api)
    ? resolveProviderStreamApi(params.model)
    : params.model.api;
  // The alias selects this stream; wire policy still needs the original API.
  const sourceApi = params.model.api;
  const sourceStreamFn = inheritModelRequestBinding<StreamFn>(
    (runtimeModel, context, options) =>
      streamFn(projectModel(runtimeModel, { api: sourceApi }), context, options),
    streamFn,
  );
  if (!registerCustomApi(params.apiRegistry, api, sourceStreamFn, params.support)) {
    return undefined;
  }
  return api === params.model.api ? params.model : projectModel(params.model, { api });
}

/** Read the same leaf that transport preparation selects without constructing it. */
export function readSimpleCompletionModelRequestBindingSupport(
  apiRegistry: ApiRegistry,
  model: Model,
): ModelRequestBindingLeafSupport | undefined {
  return getAiTransportHost().requiresManagedTransport(model)
    ? readTransportModelRequestBindingSupport(model)
    : apiRegistry.getApiProvider(model.api)?.modelRequestBindingSupport?.streamSimple;
}

export function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  apiRegistry: ApiRegistry;
  model: Model<TApi>;
  cfg?: unknown;
  transport?: SimpleStreamOptions["transport"];
}): Model {
  const { apiRegistry, cfg } = params;
  const host = getAiTransportHost();
  const leaf = readSimpleCompletionModelRequestBindingSupport(apiRegistry, params.model);
  const preparation = host.plugin.prepareModelRequestBinding?.({
    model: params.model,
    config: cfg,
    transport: params.transport,
    leaf,
    wrapper: "wrapSimpleCompletionStreamFn",
  });
  const model = preparation?.model ?? params.model;
  const support = preparation?.support;
  const wrap = (selected: Model) =>
    applyProviderSimpleCompletionWrapper(
      apiRegistry,
      selected,
      cfg,
      model.api,
      params.transport,
      support,
    );
  const providerStreamModel = prepareProviderStreamModel({
    model,
    cfg,
    apiRegistry,
    transport: params.transport,
    support,
  });
  if (providerStreamModel) {
    return wrap(providerStreamModel);
  }

  const codexTransportModel = prepareCodexSimpleTransportModel(apiRegistry, model, cfg);
  if (codexTransportModel) {
    return wrap(codexTransportModel);
  }

  const transportAwareModel = prepareTransportAwareSimpleModel(model, { cfg });
  if (transportAwareModel !== model) {
    const streamFn = buildTransportAwareSimpleStreamFn(model, { cfg });
    if (streamFn && registerCustomApi(apiRegistry, transportAwareModel.api, streamFn, support)) {
      return wrap(transportAwareModel);
    }
  }

  if (model.provider === "anthropic-vertex") {
    const api = resolveAnthropicVertexSimpleApi(model.baseUrl);
    const vertexHost = getAiTransportHost();
    const streamFn = vertexHost.plugin.createAnthropicVertexStream(model);
    if (registerCustomApi(apiRegistry, api, streamFn)) {
      const transportModel = projectModel(model, { api });
      return wrap(transportModel);
    }
  }

  return wrap(model);
}
