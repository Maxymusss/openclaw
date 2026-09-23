import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { inheritModelRequestBinding } from "@openclaw/llm-core";
import {
  assertProviderModelRequestBindingHook,
  assertProviderModelRequestBindingResult,
  guardProviderModelRequestBinding,
} from "../agents/provider-model-request-binding.js";
import type { StreamFn } from "../agents/runtime/index.js";
import {
  ensureProviderRuntimePluginHandle,
  resolveLoadedProviderRuntimePlugin,
  resolveProviderRuntimePlugin,
  type ProviderRuntimePluginHandle,
} from "./provider-hook-runtime.js";
import type { ProviderCreateStreamFnContext } from "./types.js";

export function resolveProviderStreamFn(
  params: Pick<
    Parameters<typeof resolveProviderRuntimePlugin>[0],
    "provider" | "config" | "workspaceDir" | "env"
  > & {
    runtimeHandle?: ProviderRuntimePluginHandle;
    allowRuntimePluginLoad?: boolean;
    context: ProviderCreateStreamFnContext;
    preparedTransport?: import("./provider-transport.types.js").ProviderModelRequestBindingContext["transport"];
  },
): StreamFn | undefined {
  // Transport families may explicitly ask for a different fallback owner.
  const plugin =
    params.runtimeHandle?.provider === params.provider
      ? ensureProviderRuntimePluginHandle(params).plugin
      : params.allowRuntimePluginLoad === false
        ? resolveLoadedProviderRuntimePlugin(params)
        : resolveProviderRuntimePlugin(params);
  const finite = assertProviderModelRequestBindingHook({
    model: params.context.model,
    plugin,
    transport: params.preparedTransport,
    hook: "createStreamFn",
    isCurrent: params.runtimeHandle?.isModelRequestBindingCurrent,
  });
  const created = plugin?.createStreamFn?.(params.context);
  if (plugin?.createStreamFn) {
    assertProviderModelRequestBindingResult(finite, created);
  }
  const streamFn =
    created &&
    guardProviderModelRequestBinding(created, {
      model: params.context.model,
      plugin,
      transport: params.preparedTransport,
      isCurrent: params.runtimeHandle?.isModelRequestBindingCurrent,
    });
  if (!streamFn || plugin?.supportsSystemPromptCacheBoundary) {
    return streamFn ?? undefined;
  }
  return inheritModelRequestBinding<StreamFn>(
    (model, context, options) =>
      streamFn(
        model,
        context.systemPrompt
          ? { ...context, systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt) }
          : context,
        options,
      ),
    streamFn,
  );
}
