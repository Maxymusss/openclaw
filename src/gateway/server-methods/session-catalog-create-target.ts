import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  SessionCatalogCreateTarget,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { catalogError } from "./session-catalog-result.js";

type ProviderCreateTargetResolution =
  | { ok: true; target: SessionCatalogCreateTarget }
  | { ok: false; message: string };

const providerCreateTargetsByConfig = new WeakMap<
  OpenClawConfig,
  WeakMap<SessionCatalogProvider, Map<string, ProviderCreateTargetResolution>>
>();

function providerCreateTargetCache(
  config: OpenClawConfig,
  provider: SessionCatalogProvider,
): Map<string, ProviderCreateTargetResolution> {
  let byProvider = providerCreateTargetsByConfig.get(config);
  if (!byProvider) {
    byProvider = new WeakMap();
    providerCreateTargetsByConfig.set(config, byProvider);
  }
  let byAgent = byProvider.get(provider);
  if (!byAgent) {
    byAgent = new Map();
    byProvider.set(provider, byAgent);
  }
  return byAgent;
}

export function resolveProviderCreateTarget(
  provider: SessionCatalogProvider,
  agentId: string,
  config: OpenClawConfig,
): ProviderCreateTargetResolution {
  const cache = providerCreateTargetCache(config, provider);
  const cached = cache.get(agentId);
  if (cached) {
    // The provider contract makes create targets config-derived. A reload changes config identity;
    // retaining the old target would advertise a model no longer allowed.
    return cached;
  }
  let resolution: ProviderCreateTargetResolution;
  try {
    const target = provider.resolveCreateSession?.({ agentId });
    const model = target?.model.trim();
    const agentRuntime = target?.agentRuntime.trim();
    resolution =
      model && agentRuntime
        ? { ok: true, target: { model, agentRuntime } }
        : { ok: false, message: `session catalog ${provider.id} cannot create sessions` };
  } catch (error) {
    // Resolver exceptions are not config state. Retry them on the next request so a transient
    // provider initialization failure cannot suppress session creation until config reload.
    return { ok: false, message: catalogError(error).message };
  }
  cache.set(agentId, resolution);
  return resolution;
}
