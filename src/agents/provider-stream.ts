import type { ApiRegistry } from "@openclaw/ai";
import {
  createTransportAwareStreamFnForModel,
  isTransportAwareApiSupported,
  readTransportModelRequestBindingSupport,
} from "@openclaw/ai/transports";
import "./ai-transport-runtime-host.js";
/**
 * Provider stream registration entry point.
 * Resolves plugin-owned or transport-aware stream functions and registers the
 * model API once a concrete stream implementation exists.
 */
import { inheritModelRequestBinding } from "@openclaw/llm-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getModelLlmRuntime } from "../llm/model-runtime-binding.js";
import type { Api, Model, SimpleStreamOptions } from "../llm/types.js";
import {
  attachModelProviderRuntimePluginHandle,
  getModelProviderRuntimePluginHandle,
  resolveProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../plugins/provider-hook-runtime.js";
import { readProviderModelRequestBindingSupport } from "../plugins/provider-model-request-binding.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import {
  resolvePreparedExtraParams,
  resolveSupportedTransport,
} from "./embedded-agent-runner/extra-params.js";
import {
  guardOperatorModelProviderStream,
  runWithOperatorModelRequest,
} from "./operator-model-policy.js";
import {
  assertProviderModelRequestBinding,
  constructProviderModelStreamWrapper,
  guardProviderModelRequestBinding,
} from "./provider-model-request-binding.js";
import {
  unwrapHeaderSentinelsForProviderEgress,
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import type { StreamFn } from "./runtime/index.js";

/** Resolves and registers the stream function for a provider-backed model. */
export function registerProviderStreamForModel<TApi extends Api>(params: {
  model: Model<TApi>;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  preparedExtraParams?: Record<string, unknown>;
  preparedTransport?: SimpleStreamOptions["transport"];
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowRuntimePluginLoad?: boolean;
  wrapProviderStream?: boolean;
  apiRegistry?: ApiRegistry;
}): StreamFn | undefined {
  return runWithOperatorModelRequest(params.operatorAuthority, (operatorAuthority) =>
    registerProviderStreamCore({ ...params, operatorAuthority }),
  );
}

function registerProviderStreamCore<TApi extends Api>(
  params: Parameters<typeof registerProviderStreamForModel<TApi>>[0],
): StreamFn | undefined {
  const apiRegistry = params.apiRegistry ?? getModelLlmRuntime(params.model)?.registry;
  const runtimeHandle =
    getModelProviderRuntimePluginHandle(params.model) ??
    (params.allowRuntimePluginLoad === false
      ? undefined
      : resolveProviderRuntimePluginHandle({
          provider: params.model.provider,
          modelId: params.model.id,
          config: params.cfg,
          workspaceDir: params.workspaceDir,
          env: params.env,
        }));
  const runtimeModel = runtimeHandle
    ? attachModelProviderRuntimePluginHandle(params.model, runtimeHandle)
    : params.model;
  const extraParams =
    params.preparedExtraParams ??
    resolvePreparedExtraParams({
      cfg: params.cfg,
      provider: runtimeModel.provider,
      modelId: runtimeModel.id,
      model: runtimeModel,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      providerRuntimeHandle: runtimeHandle,
    });
  // An explicitly prepared unknown transport must not fall back to a provider default.
  const transport = Object.hasOwn(params, "preparedTransport")
    ? params.preparedTransport
    : resolveSupportedTransport(extraParams?.transport);
  const leaf = isTransportAwareApiSupported(runtimeModel.api)
    ? readTransportModelRequestBindingSupport(runtimeModel)
    : apiRegistry?.getApiProvider(runtimeModel.api)?.modelRequestBindingSupport?.streamSimple;
  const binding = {
    model: runtimeModel,
    plugin: runtimeHandle?.plugin,
    isCurrent: runtimeHandle?.isModelRequestBindingCurrent,
    transport,
    leaf,
    ...(params.wrapProviderStream ? { wrapper: "wrapStreamFn" as const } : {}),
  };
  assertProviderModelRequestBinding(binding);
  // Plugin stream factories may capture model headers, so construction is the
  // last safe boundary for providers that do not expose the host fetch seam.
  const pluginModel = unwrapModelHeaderSentinelsForProviderEgress(
    runtimeModel,
    "plugin provider stream construction",
  );
  const providerStreamFn = resolveProviderStreamFn({
    provider: runtimeModel.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    runtimeHandle,
    allowRuntimePluginLoad: params.allowRuntimePluginLoad,
    preparedTransport: transport,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: runtimeModel.provider,
      modelId: runtimeModel.id,
      model: pluginModel,
    },
  });
  const transportFallback = providerStreamFn
    ? undefined
    : createTransportAwareStreamFnForModel(
        runtimeModel.api === "google-generative-ai" ? pluginModel : runtimeModel,
        {
          cfg: params.cfg,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          env: params.env,
        },
      );
  const baseStreamFn = providerStreamFn
    ? wrapPluginProviderStream(providerStreamFn)
    : transportFallback && params.model.api === "google-generative-ai"
      ? wrapPluginProviderStream(transportFallback)
      : transportFallback;
  if (!baseStreamFn) {
    return undefined;
  }
  const streamFn = guardOperatorModelProviderStream(baseStreamFn);
  const providerWrappedStreamFn =
    params.wrapProviderStream && runtimeHandle
      ? (constructProviderModelStreamWrapper({
          ...binding,
          hook: "wrapStreamFn",
          context: {
            config: params.cfg,
            agentDir: params.agentDir,
            workspaceDir: params.workspaceDir,
            provider: runtimeModel.provider,
            modelId: runtimeModel.id,
            model: runtimeModel,
            streamFn,
          },
        }) ?? streamFn)
      : streamFn;
  const preparedStreamFn = runtimeHandle
    ? bindProviderRuntimeHandle(
        guardProviderModelRequestBinding(
          guardOperatorModelProviderStream(providerWrappedStreamFn),
          binding,
        ),
        runtimeHandle,
      )
    : guardProviderModelRequestBinding(
        guardOperatorModelProviderStream(providerWrappedStreamFn),
        binding,
      );
  // Register custom APIs only after a concrete stream exists, so later callers
  // can route by model.api without reloading provider runtime hooks.
  if (apiRegistry) {
    ensureCustomApiRegistered(
      apiRegistry,
      runtimeModel.api,
      preparedStreamFn,
      readProviderModelRequestBindingSupport(binding),
    );
  }
  return preparedStreamFn;
}

function bindProviderRuntimeHandle(
  streamFn: StreamFn,
  runtimeHandle: ProviderRuntimePluginHandle,
): StreamFn {
  return inheritModelRequestBinding<StreamFn>(
    (model, context, options) =>
      streamFn(attachModelProviderRuntimePluginHandle(model, runtimeHandle), context, options),
    streamFn,
  );
}

function wrapPluginProviderStream(streamFn: StreamFn): StreamFn {
  const boundary = "plugin provider stream handoff";
  return inheritModelRequestBinding<StreamFn>((model, context, options) => {
    const apiKey = options?.apiKey
      ? unwrapSecretSentinelsForProviderEgress(options.apiKey, boundary)
      : options?.apiKey;
    const headers = options?.headers
      ? unwrapHeaderSentinelsForProviderEgress(options.headers, boundary)
      : options?.headers;
    const resolvedOptions =
      apiKey === options?.apiKey && headers === options?.headers
        ? options
        : { ...options, apiKey, headers };
    return streamFn(
      unwrapModelHeaderSentinelsForProviderEgress(model, boundary),
      context,
      resolvedOptions,
    );
  }, streamFn);
}
