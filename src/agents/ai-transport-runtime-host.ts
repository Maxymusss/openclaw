import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiProviderRequestCapabilities,
} from "@openclaw/ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../llm/ai-transport-host.js";
import {
  attachModelProviderRuntimePluginHandle,
  getModelProviderRuntimePluginHandle,
  resolveProviderRuntimePluginHandle,
} from "../plugins/provider-hook-runtime.js";
import { readProviderModelRequestBindingSupport } from "../plugins/provider-model-request-binding.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import {
  resolveProviderStreamFn,
  resolveProviderTransportTurnStateWithPlugin,
  wrapProviderSimpleCompletionStreamFn,
} from "../plugins/provider-runtime.js";
import { createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { guardOperatorModelProviderStream } from "./operator-model-policy.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";
import {
  attachModelProviderLocalService,
  getModelProviderLocalService,
} from "./provider-local-service.js";
import { assertProviderModelRequestBinding } from "./provider-model-request-binding.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
  getModelProviderRequestRouteFacts,
  inheritModelProviderRequestRouteFacts,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";
import { transformTransportMessages } from "./transport-message-transform.js";

let configured = false;

/** Installs the agent and plugin ports only on paths that execute provider runtime. */
export function configureAiTransportRuntimeHost(): void {
  if (configured) {
    return;
  }
  const host = getAiTransportHost();
  configureAiTransportHost({
    ...host,
    plugin: {
      ...host.plugin,
      prepareModelRequestBinding: (params) => {
        const captured = getModelProviderRuntimePluginHandle(params.model);
        const handle =
          captured ??
          resolveProviderRuntimePluginHandle({
            provider: params.model.provider,
            modelId: params.model.id,
            // SAFETY: the package port keeps config opaque; core passes OpenClawConfig through unchanged.
            config: params.config as OpenClawConfig | undefined,
          });
        const binding = {
          ...params,
          plugin: handle.plugin,
          isCurrent: handle.isModelRequestBindingCurrent,
        };
        assertProviderModelRequestBinding(binding);
        return {
          model: captured
            ? params.model
            : attachModelProviderRuntimePluginHandle(params.model, handle),
          support: readProviderModelRequestBindingSupport(binding),
        };
      },
      resolveProviderStream: (params) =>
        resolveProviderStreamFn({
          ...params,
          config: params.config as OpenClawConfig | undefined,
          runtimeHandle: getModelProviderRuntimePluginHandle(params.context.model),
          context: {
            ...params.context,
            config: params.context.config as OpenClawConfig | undefined,
            model: params.context.model as ProviderRuntimeModel,
          },
        }),
      resolveTransportTurnState: (params) =>
        resolveProviderTransportTurnStateWithPlugin({
          ...params,
          config: params.config as OpenClawConfig | undefined,
          runtimeHandle: getModelProviderRuntimePluginHandle(params.context.model),
          context: {
            ...params.context,
            model: params.context.model as ProviderRuntimeModel | undefined,
          },
        }),
      wrapSimpleCompletionStream: (params) =>
        wrapProviderSimpleCompletionStreamFn({
          ...params,
          config: params.config as OpenClawConfig | undefined,
          runtimeHandle: getModelProviderRuntimePluginHandle(params.context.model),
          context: {
            ...params.context,
            config: params.context.config as OpenClawConfig | undefined,
            model: params.context.model as ProviderRuntimeModel,
            streamFn: guardOperatorModelProviderStream(params.context.streamFn),
          },
        }),
      createAnthropicVertexStream: createAnthropicVertexStreamFnForModel,
    },
    buildCopilotDynamicHeaders: (messages) =>
      buildCopilotDynamicHeaders({ messages, hasImages: hasCopilotVisionInput(messages) }),
    resolveProviderRequestCapabilities: (input) =>
      (getModelProviderRequestRouteFacts(input.model ?? {})?.capabilities ??
        resolveProviderRequestCapabilities(input)) as AiProviderRequestCapabilities,
    resolveProviderRequestHeaders: (input) =>
      resolveProviderRequestPolicyConfig({
        ...input,
        routeFacts: getModelProviderRequestRouteFacts(input.model ?? {}),
        capability: "llm",
        transport: "stream",
      }).headers,
    requiresManagedTransport: (model) => {
      const request = getModelProviderRequestTransport(model);
      return Boolean(request?.proxy || request?.tls || getModelProviderLocalService(model));
    },
    inheritManagedTransport: (source, target) =>
      inheritModelProviderRequestRouteFacts(
        source,
        attachModelProviderLocalService(
          attachModelProviderRequestTransport(target, getModelProviderRequestTransport(source)),
          getModelProviderLocalService(source),
        ),
      ),
    transformTransportMessages,
    registerCustomApi: ensureCustomApiRegistered,
  });
  configured = true;
}

configureAiTransportRuntimeHost();
