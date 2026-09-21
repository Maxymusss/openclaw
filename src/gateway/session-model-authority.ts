import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { BUILTIN_AGENT_HARNESS_METADATA } from "../agents/harness/builtin-openclaw-metadata.js";
import type { AgentHarness } from "../agents/harness/types.js";
import {
  assertOperatorModelAllowed,
  assertOperatorModelHarnessSupported,
  isOperatorModelPolicyError,
} from "../agents/operator-model-policy.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Selection and its later COMMIT use the same original source and resolved session tuple. */
export function resolveSessionModelAuthorityError(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: SessionEntry;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  preparedRuntime?: { harness?: AgentHarness };
}): ErrorShape | undefined {
  try {
    const model = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
    assertOperatorModelAllowed(params.operatorAuthority, model.provider, model.model);
    if (params.preparedRuntime) {
      const runtime = resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        agentId: params.agentId,
        provider: model.provider,
        modelId: model.model,
        sessionEntry: params.entry,
      });
      assertOperatorModelHarnessSupported(
        params.operatorAuthority,
        params.preparedRuntime.harness ??
          (runtime === "openclaw" ? BUILTIN_AGENT_HARNESS_METADATA : {}),
      );
    }
    return undefined;
  } catch (error) {
    if (!isOperatorModelPolicyError(error)) {
      throw error;
    }
    return errorShape(
      ErrorCodes.FORBIDDEN,
      error instanceof Error ? error.message : "Model selection denied.",
    );
  }
}
