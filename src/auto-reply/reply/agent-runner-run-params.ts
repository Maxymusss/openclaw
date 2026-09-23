/** Builds embedded-agent run parameters from queued follow-up run state. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  modelFallbackOverrideFromAvailability,
  resolveModelFallbackAvailability,
} from "../../agents/agent-scope.js";
import { findModelInCatalog, modelSupportsInput } from "../../agents/model-catalog-lookup.js";
import { modelTransportRoutesMatch } from "../../agents/model-compat-catalog.js";
import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../../config/model-provider-config.js";
import type { resolveProviderScopedAuthProfile } from "./agent-runner-auth-profile.js";
import type { FollowupRun } from "./queue.js";

/** Callback used to detect providers that require final-answer tags. */
type ReasoningTagProviderResolver = (
  provider: string,
  options: {
    config: FollowupRun["run"]["config"];
    workspaceDir: string;
    modelId: string;
  },
) => boolean;

/** Builds model fallback options for an embedded follow-up run. */
export function resolveModelFallbackOptions(
  run: FollowupRun["run"],
  configOverride: FollowupRun["run"]["config"] = run.config,
) {
  const config = configOverride;
  const modelFallbackAvailability = resolveModelFallbackAvailability({
    cfg: config,
    agentId: run.agentId,
    sessionKey: run.sessionKey,
    hasSessionModelOverride: run.hasSessionModelOverride === true,
    modelOverrideSource: run.modelOverrideSource,
    hasAutoFallbackProvenance: run.hasAutoFallbackProvenance === true,
    modelSelectionLocked: run.modelSelectionLocked,
    subagentSpawnLineage: run.subagentSpawnLineage,
  });
  return {
    cfg: config,
    provider: run.provider,
    model: run.model,
    requestedRouteResolution: run.requestedRouteResolution,
    agentDir: run.agentDir,
    agentId: run.agentId,
    sessionKey: run.runtimePolicySessionKey ?? run.sessionKey,
    modelFallbackAvailability,
    fallbacksOverride: modelFallbackOverrideFromAvailability(modelFallbackAvailability),
  };
}

/** Resolves whether final-answer tags should be enforced for an embedded follow-up run. */
function resolveEnforceFinalTagWithResolver(
  run: FollowupRun["run"],
  provider: string,
  model: string,
  isReasoningTagProvider?: ReasoningTagProviderResolver,
): boolean {
  return (
    (run.skipProviderRuntimeHints ? false : undefined) ??
    (run.enforceFinalTag ||
      isReasoningTagProvider?.(provider, {
        config: run.config,
        workspaceDir: run.workspaceDir,
        modelId: model,
      }) ||
      false)
  );
}

/** Read authoritative configured/prepared input without optional discovery. */
function prepareRunModelInput(params: {
  run: Pick<FollowupRun["run"], "config"> &
    Partial<Pick<FollowupRun["run"], "agentId" | "agentDir" | "workspaceDir" | "thinkingCatalog">>;
  provider: string;
  model: string;
}) {
  const { run, provider, model } = params;
  const providerConfig = resolveMergedModelProviderConfig(run.config, provider);
  const configured = findConfiguredProviderModel(
    providerConfig,
    provider,
    model,
    normalizeLowercaseStringOrEmpty,
  );
  const route = {
    api: configured?.api ?? providerConfig?.api,
    baseUrl: configured?.baseUrl ?? providerConfig?.baseUrl,
  };
  const prepared = findModelInCatalog(run.thinkingCatalog ?? [], provider, model);
  const inputOwner =
    configured?.input !== undefined
      ? configured
      : prepared?.input !== undefined && modelTransportRoutesMatch(prepared, route)
        ? prepared
        : undefined;
  return {
    route,
    modelHasVision: inputOwner ? modelSupportsInput(inputOwner, "image") : undefined,
  };
}

/** Resolve missing input only after the selected execution owner admitted auth. */
export async function resolveRunModelHasVision(
  params: Parameters<typeof prepareRunModelInput>[0],
): Promise<boolean> {
  const prepared = prepareRunModelInput(params);
  if (prepared.modelHasVision !== undefined) {
    return prepared.modelHasVision;
  }
  const { run, provider, model } = params;
  const { loadProviderScopedThinkingCatalog } =
    await import("../../agents/model-catalog.runtime.js");
  const catalog = await loadProviderScopedThinkingCatalog({
    config: run.config,
    provider,
    model,
    agentId: run.agentId,
    agentDir: run.agentDir,
    workspaceDir: run.workspaceDir,
    requiredInputRoute: prepared.route,
  });
  return modelSupportsInput(findModelInCatalog(catalog, provider, model), "image");
}

/** Builds the shared embedded-agent run params from a queued follow-up run. */
export async function buildEmbeddedRunBaseParams(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
  runId: string;
  promptCacheKey?: string;
  authProfile: ReturnType<typeof resolveProviderScopedAuthProfile>;
  allowTransientCooldownProbe?: boolean;
  isReasoningTagProvider?: ReasoningTagProviderResolver;
}) {
  const config = params.run.config;
  const modelFallbackAvailability = resolveModelFallbackAvailability({
    cfg: config,
    agentId: params.run.agentId,
    sessionKey: params.run.sessionKey,
    hasSessionModelOverride: params.run.hasSessionModelOverride === true,
    modelOverrideSource: params.run.modelOverrideSource,
    hasAutoFallbackProvenance: params.run.hasAutoFallbackProvenance === true,
    modelSelectionLocked: params.run.modelSelectionLocked,
    subagentSpawnLineage: params.run.subagentSpawnLineage,
  });
  const modelFallbacksOverride = modelFallbackOverrideFromAvailability(modelFallbackAvailability);
  const enforceFinalTag = resolveEnforceFinalTagWithResolver(
    params.run,
    params.provider,
    params.model,
    params.isReasoningTagProvider,
  );
  // Runtime policy keys may differ from session keys for direct-message scoped policy.
  const runParams = {
    providerReviewAcknowledgment: params.run.providerReviewAcknowledgment,
    sessionFile: params.run.sessionFile,
    workspaceDir: params.run.workspaceDir,
    cwd: params.run.cwd,
    permissionMode: params.run.permissionMode,
    sessionRoot: params.run.sessionRoot,
    agentDir: params.run.agentDir,
    config,
    toolOverrides: params.run.toolOverrides,
    skillsSnapshot: params.run.skillsSnapshot,
    ownerNumbers: params.run.ownerNumbers,
    inputProvenance: params.run.inputProvenance,
    trustedInternalHandoff: params.run.trustedInternalHandoff,
    scheduledToolPolicy: params.run.scheduledToolPolicy,
    runtimePluginToolGrant: params.run.runtimePluginToolGrant,
    senderIsOwner: params.run.senderIsOwner,
    conversationToolPolicy: params.run.conversationToolPolicy,
    channelContext: params.run.channelContext,
    approvalReviewerDeviceId: params.run.approvalReviewerDeviceId,
    enforceFinalTag,
    silentExpected: params.run.silentExpected,
    terminalReplyExpectation: params.run.terminalReplyExpectation,
    silentReplyPromptMode: params.run.silentReplyPromptMode,
    sourceReplyDeliveryMode: params.run.sourceReplyDeliveryMode,
    clientCaps: params.run.clientCaps,
    bootstrapUserProfileId: params.run.bootstrapUserProfileId,
    gatewayUiCommandTarget: params.run.gatewayUiCommandTarget,
    toolBindings: params.run.toolBindings,
    taskSuggestionDeliveryMode: params.run.taskSuggestionDeliveryMode,
    skillWorkshopProposalRevision: params.run.skillWorkshopProposalRevision,
    skillLibraryAuthoring: params.run.skillLibraryAuthoring,
    provider: params.provider,
    model: params.model,
    modelHasVision: prepareRunModelInput(params).modelHasVision,
    deferModelInput: true,
    modelInputCatalog: params.run.thinkingCatalog,
    deferredReplyModelLevels: params.run.deferredReplyModelLevels,
    requestedRouteResolution: "resolved" as const,
    modelSelectionLocked: params.run.modelSelectionLocked,
    modelFallbackAvailability,
    modelFallbacksOverride,
    ...params.authProfile,
    thinkLevel: params.run.thinkLevel,
    fastMode: params.run.fastMode,
    fastModeAutoOnSeconds: params.run.fastModeAutoOnSeconds,
    verboseLevel: params.run.verboseLevel,
    reasoningLevel: params.run.reasoningLevel,
    execOverrides: params.run.execOverrides,
    bashElevated: params.run.bashElevated,
    timeoutMs: params.run.timeoutMs,
    runTimeoutOverrideMs: params.run.runTimeoutOverrideMs,
    runId: params.runId,
    promptCacheKey: params.promptCacheKey,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
  };
  return runParams;
}
