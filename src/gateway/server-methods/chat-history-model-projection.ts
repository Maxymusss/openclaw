import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { findModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import type { GatewaySessionRow, GatewaySessionsDefaults } from "../session-utils.types.js";

/** Shared catalog facts are decorated only on caller-owned response projections. */
export function projectChatHistoryThinking(params: {
  cfg: OpenClawConfig;
  sessionAgentId: string;
  canonicalKey: string;
  sessionInfo: GatewaySessionRow | undefined;
  defaults: GatewaySessionsDefaults | undefined;
  sessionModelCatalog: ModelCatalogEntry[] | undefined;
  defaultModelCatalog: ModelCatalogEntry[] | undefined;
}) {
  const {
    cfg,
    sessionAgentId,
    canonicalKey,
    sessionInfo,
    defaults,
    sessionModelCatalog,
    defaultModelCatalog,
  } = params;
  // Unprepared catalog facts are unknown, not an Off default or a smaller profile.
  // Omission lets clients retain richer same-identity metadata; authored defaults still apply.
  for (const [projection, catalog] of [
    [sessionInfo, sessionModelCatalog],
    [defaults, defaultModelCatalog],
  ] as const) {
    if (!projection) {
      continue;
    }
    const provider = projection.modelProvider;
    const model = projection.model;
    const catalogEntry =
      catalog && provider && model
        ? findModelCatalogEntry(catalog, { provider, modelId: model })
        : undefined;
    if (typeof catalogEntry?.reasoning === "boolean" && provider && model) {
      // Chat metadata carries the selected session auth route's capabilities.
      Object.assign(
        projection,
        resolveGatewayModelThinkingProfile({
          cfg,
          agentId: sessionAgentId,
          provider,
          model,
          modelCatalog: catalog,
          agentRuntime: projection.agentRuntime?.id,
          sessionKey: projection === sessionInfo ? canonicalKey : undefined,
          providerPolicySource: "active",
        }),
      );
      projection.thinkingOptions = projection.thinkingLevels?.map(({ label }) => label);
      continue;
    }
    delete projection.thinkingLevels;
    delete projection.thinkingOptions;
    projection.thinkingDefault =
      resolveAgentConfig(cfg, sessionAgentId)?.thinkingDefault ??
      (provider && model
        ? resolveConfiguredThinkingDefault({ cfg, provider, model })
        : cfg.agents?.defaults?.thinkingDefault);
  }
}
