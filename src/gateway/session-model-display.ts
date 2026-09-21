import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveCliRuntimeCanonicalProvider } from "../agents/cli-backends.js";
import { isCliProvider, parseModelRef } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createSessionRowModelCacheKey,
  type SessionListRowContext,
} from "./session-utils-contracts.js";

export function resolveSessionDisplayModelIdentityRefCached(params: {
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
  rowContext?: SessionListRowContext;
}): { provider?: string; model?: string } {
  const ctx = params.rowContext;
  if (!ctx) {
    return resolveSessionDisplayModelIdentityRef(params);
  }
  const key = createSessionRowModelCacheKey(params.provider, params.model);
  const cached = ctx.displayModelIdentityByKey.get(key);
  if (cached) {
    return cached;
  }
  const value = resolveSessionDisplayModelIdentityRef(params);
  ctx.displayModelIdentityByKey.set(key, value);
  return value;
}

export function resolveSessionDisplayModelIdentityRef(params: {
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
}): { provider?: string; model?: string } {
  const provider = normalizeOptionalString(params.provider);
  const model = normalizeOptionalString(params.model);
  if (!provider || !model || !isCliProvider(provider, params.cfg)) {
    return { provider, model };
  }

  const identity = (model.includes("/")
    ? parseModelRef(model, provider, {
        allowPluginNormalization: false,
        allowManifestNormalization: false,
      })
    : null) ?? { provider, model };
  return {
    provider:
      resolveCliRuntimeCanonicalProvider({
        runtime: identity.provider,
        config: params.cfg,
        includeSetupRegistry: true,
      }) ?? identity.provider,
    model: identity.model,
  };
}
