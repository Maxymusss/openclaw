import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { PreparedOperatorModelPolicy } from "../agents/operator-model-policy.types.js";
import type {
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionsPatchResult,
} from "./session-utils.types.js";

function visibleModel(
  policy: PreparedOperatorModelPolicy | undefined,
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  return !policy || Boolean(provider && model && policy.allows({ provider, model }));
}

/** Redact only this caller's presentation; the shared row/catalog remains neutral. */
export function projectOperatorSessionModel(
  row: GatewaySessionRow,
  policy: PreparedOperatorModelPolicy | undefined,
): GatewaySessionRow {
  if (!policy) {
    return row;
  }
  const result = { ...row };
  if (!visibleModel(policy, row.modelProvider, row.model)) {
    delete result.model;
    delete result.modelProvider;
    delete result.modelOverrideSource;
    delete result.agentRuntime;
    delete result.thinkingLevel;
    delete result.thinkingDefault;
    delete result.thinkingLevels;
    delete result.thinkingOptions;
    delete result.contextTokens;
    delete result.contextWindow;
    delete result.contextWindows;
    delete result.contextWindowDefault;
  }
  if (!visibleModel(policy, row.activeModelProvider, row.activeModel)) {
    delete result.activeModel;
    delete result.activeModelProvider;
  }
  return result;
}

export function projectOperatorSessionDefaults(
  defaults: GatewaySessionsDefaults,
  policy: PreparedOperatorModelPolicy | undefined,
): GatewaySessionsDefaults {
  if (visibleModel(policy, defaults.modelProvider, defaults.model)) {
    return defaults;
  }
  return {
    modelProvider: null,
    model: null,
    contextTokens: null,
    ...(defaults.modelSelectionTarget
      ? { modelSelectionTarget: defaults.modelSelectionTarget }
      : {}),
  };
}

/** A metadata-only patch may succeed while its saved model is outside the caller's ceiling. */
export function projectOperatorSessionPatch<
  T extends Pick<SessionsPatchResult, "entry" | "resolved">,
>(
  result: T,
  policy: PreparedOperatorModelPolicy | undefined,
  selected: { provider: string; model: string },
): Omit<T, "entry" | "resolved"> & Pick<SessionsPatchResult, "entry" | "resolved"> {
  if (!policy) {
    return result;
  }
  const entry = { ...result.entry };
  const selectionVisible = visibleModel(policy, selected.provider, selected.model);
  const visibleRef = (ref: string) => {
    const parsed = parseProviderModelRef(ref);
    return parsed !== null && visibleModel(policy, parsed.provider, parsed.model);
  };
  if (!selectionVisible) {
    delete entry.providerOverride;
    delete entry.modelOverride;
    delete entry.modelOverrideSource;
    delete entry.modelOverrideRouteResolution;
    delete entry.agentRuntimeOverride;
    delete entry.authProfileOverride;
    delete entry.authProfileOverrideSource;
    delete entry.authProfileOverrideCompactionCount;
    delete entry.thinkingLevel;
    delete entry.contextWindow;
    delete entry.contextTokens;
    delete entry.liveModelSwitchPending;
    delete entry.modelSelectionLocked;
    delete entry.agentHarnessId;
    delete entry.acp;
    delete entry.acpSessionBinding;
    delete entry.cliSessionIds;
    delete entry.cliSessionBindings;
    delete entry.claudeCliSessionId;
  }
  if (!visibleModel(policy, entry.modelProvider, entry.model)) {
    delete entry.modelProvider;
    delete entry.model;
  }
  // Nested runtime receipts also carry tuples. Copy only changed presentation
  // branches so label patches cannot leak them or mutate the durable source row.
  if (
    entry.fallbackNotice &&
    (!visibleRef(entry.fallbackNotice.selectedModel) ||
      !visibleRef(entry.fallbackNotice.activeModel))
  ) {
    delete entry.fallbackNotice;
  }
  if (
    entry.systemPromptReport &&
    !visibleModel(policy, entry.systemPromptReport.provider, entry.systemPromptReport.model)
  ) {
    entry.systemPromptReport = { ...entry.systemPromptReport };
    delete entry.systemPromptReport.provider;
    delete entry.systemPromptReport.model;
  }
  if (entry.pendingTranscriptRepair) {
    entry.pendingTranscriptRepair = entry.pendingTranscriptRepair.map((repair) => {
      if (visibleModel(policy, repair.provider, repair.model)) {
        return repair;
      }
      const { provider: _provider, model: _model, ...content } = repair;
      return content;
    });
  }
  if (
    entry.contextBudgetStatus &&
    !visibleModel(policy, entry.contextBudgetStatus.provider, entry.contextBudgetStatus.model)
  ) {
    delete entry.contextBudgetStatus;
  }
  if (
    entry.quotaSuspension &&
    !visibleModel(policy, entry.quotaSuspension.failedProvider, entry.quotaSuspension.failedModel)
  ) {
    delete entry.quotaSuspension;
  }
  const runtimeOptions = entry.acp?.runtimeOptions;
  if (entry.acp && runtimeOptions?.model && !visibleRef(runtimeOptions.model)) {
    const { model: _model, ...visibleOptions } = runtimeOptions;
    entry.acp = { ...entry.acp, runtimeOptions: visibleOptions };
  }
  if (
    !visibleModel(
      policy,
      entry.modelOverrideFallbackOriginProvider,
      entry.modelOverrideFallbackOriginModel,
    )
  ) {
    delete entry.modelOverrideFallbackOriginProvider;
    delete entry.modelOverrideFallbackOriginModel;
  }
  const fallback = entry.modelFallback;
  if (
    fallback &&
    (!visibleModel(policy, fallback.prevProvider, fallback.prevModel) ||
      (fallback.prevModelOverride !== undefined &&
        !visibleModel(policy, fallback.prevProviderOverride, fallback.prevModelOverride)) ||
      (fallback.prevModelOverrideFallbackOriginModel !== undefined &&
        !visibleModel(
          policy,
          fallback.prevModelOverrideFallbackOriginProvider,
          fallback.prevModelOverrideFallbackOriginModel,
        )))
  ) {
    delete entry.modelFallback;
  }
  const { entry: _entry, resolved, ...rest } = result;
  return { ...rest, entry, ...(selectionVisible && resolved ? { resolved } : {}) };
}
