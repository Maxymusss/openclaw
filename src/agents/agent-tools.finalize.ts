import type { ModelCompatConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import {
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.wrapper.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import { normalizeToolParameters } from "./agent-tools.schema.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { isToolWrappedWithBeforeToolCallHook } from "./before-tool-call-metadata.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";
import { createGatewayToolCallerWrapper } from "./tools/gateway-caller-context.js";

type FinalizeAgentToolsOptions = {
  tools: AnyAgentTool[];
  modelProvider?: string;
  modelId?: string;
  modelCompat?: ModelCompatConfig;
  hookContext: HookContext;
  wrapBeforeToolCallHook?: boolean;
  emitBeforeToolCallDiagnostics?: boolean;
  approvalMode?: "request" | "report" | "deny";
  abortSignal?: AbortSignal;
  recordToolPrepStage?: (name: string) => void;
};

/** Apply the shared schema, hook, abort, and description wrappers to an authorized tool set. */
export function finalizeAgentTools(options: FinalizeAgentToolsOptions): AnyAgentTool[] {
  const normalized = options.tools.map((tool) =>
    normalizeToolParameters(tool, {
      modelProvider: options.modelProvider,
      modelId: options.modelId,
      modelCompat: options.modelCompat,
    }),
  );
  options.recordToolPrepStage?.("schema-normalization");
  const hookOptions = {
    emitDiagnostics: options.emitBeforeToolCallDiagnostics,
    ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
  };
  const withHooks =
    options.wrapBeforeToolCallHook === false
      ? normalized
      : normalized.map((tool) =>
          isToolWrappedWithBeforeToolCallHook(tool)
            ? rewrapToolWithBeforeToolCallHook(tool, options.hookContext, hookOptions)
            : wrapToolWithBeforeToolCallHook(tool, options.hookContext, hookOptions),
        );
  options.recordToolPrepStage?.("tool-hooks");
  const abortSignal = options.abortSignal;
  const withAbort = abortSignal
    ? withHooks.map((tool) => wrapToolWithAbortSignal(tool, abortSignal))
    : withHooks;
  options.recordToolPrepStage?.("abort-wrappers");
  const finalized = applyToolAvailabilityDescriptions(withAbort);
  options.recordToolPrepStage?.("deferred-followup-descriptions");
  return finalized;
}

/** Preserve existing OpenClaw hooks before binding the requesting Gateway identity. */
export function finalizeOpenClawToolHooks(params: {
  allTools: AnyAgentTool[];
  options?: OpenClawToolsOptions;
  sessionAgentId: string;
  resolvedConfig?: OpenClawConfig;
  gatewayCallerAccountId?: string;
}): AnyAgentTool[] {
  const { allTools, options, sessionAgentId, resolvedConfig, gatewayCallerAccountId } = params;
  const hookAgentId = options?.requesterAgentIdOverride ?? sessionAgentId;
  const wrapGatewayCallerIdentity = createGatewayToolCallerWrapper(
    hookAgentId,
    options ? { ...options, agentAccountId: gatewayCallerAccountId } : options,
  );

  if (options?.wrapBeforeToolCallHook === false) {
    return allTools.map(wrapGatewayCallerIdentity);
  }
  const defaultHookContext: HookContext = {
    ...(hookAgentId ? { agentId: hookAgentId } : {}),
    ...(resolvedConfig ? { config: resolvedConfig } : {}),
    ...(options?.agentSessionKey ? { sessionKey: options.agentSessionKey } : {}),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.currentChannelId ? { channelId: options.currentChannelId } : {}),
    loopDetection: resolveToolLoopDetectionConfig({ cfg: resolvedConfig, agentId: hookAgentId }),
  };
  const hookContext = { ...defaultHookContext, ...options?.beforeToolCallHookContext };
  options?.recordToolPrepStage?.("openclaw-tools:tool-hooks");
  return allTools
    .map((tool) =>
      isToolWrappedWithBeforeToolCallHook(tool)
        ? tool
        : wrapToolWithBeforeToolCallHook(tool, hookContext),
    )
    .map(wrapGatewayCallerIdentity);
}
