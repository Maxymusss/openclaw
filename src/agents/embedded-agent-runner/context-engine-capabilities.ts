/**
 * Builds host capabilities passed into context-engine runtime calls.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import {
  assertOperatorModelAuthorityCurrent,
  runWithOperatorModelAuthority,
} from "../operator-model-policy.js";
import { resolveBoundAgentIdForSession } from "../session-agent-binding.js";

/** Runtime contexts carry the original host-issued capability, never a reconstructed profile. */
export function readContextEngineOperatorAuthority(
  context: ContextEngineRuntimeContext | undefined,
): AdmittedRunOperatorAuthority | undefined {
  const authority = context?.operatorAuthority;
  if (authority === undefined) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  assertOperatorModelAuthorityCurrent(authority);
  return authority;
}

type ResolveContextEngineCapabilitiesParams = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  config?: OpenClawConfig;
  sessionKey?: string;
  explicitAgentId?: string;
  authProfileId?: string;
  contextEnginePluginId?: string;
  purpose: string;
};

/**
 * Build host-owned capabilities that are bound to one context-engine runtime call.
 */
export function resolveContextEngineCapabilities(
  params: ResolveContextEngineCapabilitiesParams,
): Pick<ContextEngineRuntimeContext, "llm"> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const agentId = resolveBoundAgentIdForSession({
    config: params.config,
    sessionKey,
    agentId: params.explicitAgentId,
  });
  const contextEnginePluginId = normalizeOptionalString(params.contextEnginePluginId);
  return {
    llm: {
      complete: (request) =>
        runWithOperatorModelAuthority(params.operatorAuthority, async () => {
          const { createRuntimeLlm } = await import("../../plugins/runtime/runtime-llm.runtime.js");
          return await createRuntimeLlm({
            getConfig: () => params.config,
            authority: {
              operatorAuthority: params.operatorAuthority,
              caller: { kind: "context-engine", id: params.purpose },
              requiresBoundAgent: true,
              ...(sessionKey ? { sessionKey } : {}),
              ...(agentId ? { agentId } : {}),
              ...(params.authProfileId ? { preferredProfile: params.authProfileId } : {}),
              ...(contextEnginePluginId ? { pluginIdForPolicy: contextEnginePluginId } : {}),
              allowAgentIdOverride: false,
              allowModelOverride: false,
              allowComplete: true,
            },
          }).complete(request);
        }),
    },
  };
}
