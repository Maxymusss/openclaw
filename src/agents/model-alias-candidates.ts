import { getConfiguredModelAliases } from "../config/model-aliases.js";
import { parseModelPolicyWildcardRef } from "../config/model-policy-ref.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

export type ModelAliasCandidate = {
  keyRaw: string;
  alias: string;
  reset: boolean;
};

export function listConfiguredModelMaps(cfg: OpenClawConfig, agentId?: string) {
  return [
    cfg.agents?.defaults?.models,
    ...(agentId ? [resolveAgentConfig(cfg, agentId)?.models] : []),
  ];
}

export function listModelAliasCandidates(cfg: OpenClawConfig, agentId?: string) {
  return listConfiguredModelMaps(cfg, agentId).flatMap((models) =>
    Object.entries(models ?? {}).flatMap(([keyRaw, entryRaw]) => {
      if (parseModelPolicyWildcardRef(keyRaw)) {
        return [];
      }
      if (
        !entryRaw ||
        typeof entryRaw !== "object" ||
        (!Object.hasOwn(entryRaw, "alias") && !Object.hasOwn(entryRaw, "aliases"))
      ) {
        return [];
      }
      const aliases = getConfiguredModelAliases(entryRaw);
      return aliases.length
        ? aliases.map((alias, index) => ({ keyRaw, alias, reset: index === 0 }))
        : [{ keyRaw, alias: "", reset: true }];
    }),
  );
}
