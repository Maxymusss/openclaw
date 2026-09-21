import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../session-utils.js";
import { invalidSessionPatchOutcome } from "./sessions-patch-errors.js";
import type { MutationTarget } from "./sessions-patch-types.js";

/** Resolve one canonical target per patch before any group acquires mutation custody. */
export function prepareSessionPatchTargets(params: {
  cfg: OpenClawConfig;
  targets: readonly MutationTarget[];
}) {
  const targetDiscoveryCache = new Map();
  const targets = params.targets.map((input) => {
    const key = input.key.trim();
    const requestedAgent = resolveRequestedSessionAgentId(params.cfg, key, input.agentId);
    return {
      input,
      key,
      requestedAgent,
      resolved: requestedAgent.ok
        ? resolveGatewaySessionStoreTargetWithStore({
            cfg: params.cfg,
            key,
            agentId: requestedAgent.agentId,
            exactRead: true,
            targetDiscoveryCache,
          })
        : undefined,
    };
  });
  const logicalTargets = new Set<string>();
  for (const { key, resolved } of targets) {
    if (!resolved) {
      continue;
    }
    const logicalId = `${resolved.storePath}\0${resolved.canonicalKey ?? key}`;
    if (logicalTargets.has(logicalId)) {
      return invalidSessionPatchOutcome("Duplicate target.");
    }
    logicalTargets.add(logicalId);
  }
  return { ok: true as const, targets };
}
