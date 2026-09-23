import {
  isTransportAwareApiSupported,
  readTransportModelRequestBindingSupport,
  readSimpleCompletionModelRequestBindingSupport,
} from "@openclaw/ai/transports";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import { resolveProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { providerModelRequestBindingSupported } from "../plugins/provider-model-request-binding.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  resolvePreparedExtraParams,
  resolveSupportedTransport,
} from "./embedded-agent-runner/extra-params.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { modelMatchesProviderModelRoute } from "./provider-model-route.js";
import { getModelRegistryRuntime } from "./sessions/model-registry-runtime.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

export type PreparedModelRequestBindingReader = (selection: {
  provider: string;
  modelId: string;
  route?: ProviderModelRouteCandidate;
  api?: string;
  baseUrl?: string;
  mode?: "embedded" | "simple";
}) => boolean;

/** The reader and createStores must share the same executable catalog/registration snapshot. */
export function createPreparedModelRequestBindingReader(
  owner: Pick<
    PreparedModelRuntimeSnapshot,
    | "config"
    | "agentId"
    | "agentDir"
    | "workspaceDir"
    | "metadataSnapshot"
    | "pluginRegistry"
    | "isCurrent"
  >,
  registry: ModelRegistry,
): PreparedModelRequestBindingReader {
  return (selection) => {
    if (!owner.isCurrent() || !owner.pluginRegistry) {
      return false;
    }
    return withPluginRuntimeGenerationScope(owner, () => {
      const model = registry
        .getAll()
        .find(
          (candidate) =>
            candidate.provider === selection.provider &&
            candidate.id === selection.modelId &&
            (selection.route
              ? modelMatchesProviderModelRoute({ ...candidate, route: selection.route })
              : (!selection.api || candidate.api === selection.api) &&
                (!selection.baseUrl || candidate.baseUrl === selection.baseUrl)),
        );
      if (!model) {
        return false;
      }
      const handle = resolveProviderRuntimePluginHandle({
        provider: model.provider,
        modelId: model.id,
        config: owner.config,
        workspaceDir: owner.workspaceDir,
        pluginMetadataSnapshot: owner.metadataSnapshot,
      });
      const transport = resolveSupportedTransport(
        resolvePreparedExtraParams({
          cfg: owner.config,
          agentId: owner.agentId,
          agentDir: owner.agentDir,
          workspaceDir: owner.workspaceDir,
          provider: model.provider,
          modelId: model.id,
          model,
          providerRuntimeHandle: handle,
        }).transport,
      );
      const apiRegistry = getModelRegistryRuntime(registry).apiRegistry;
      const apiLeaf = apiRegistry.getApiProvider(model.api)?.modelRequestBindingSupport
        ?.streamSimple;
      // Default embedded selection prefers its boundary-aware constructor. Direct completion
      // uses the registry leaf; one route's declaration must never qualify the other.
      const leaf =
        selection.mode === "simple"
          ? readSimpleCompletionModelRequestBindingSupport(apiRegistry, model)
          : isTransportAwareApiSupported(model.api)
            ? readTransportModelRequestBindingSupport(model)
            : apiLeaf;
      return (
        handle.isModelRequestBindingCurrent?.() !== false &&
        providerModelRequestBindingSupported({
          model,
          plugin: handle.plugin,
          transport,
          leaf,
          wrapper: selection.mode === "simple" ? "wrapSimpleCompletionStreamFn" : "wrapStreamFn",
        })
      );
    });
  };
}
