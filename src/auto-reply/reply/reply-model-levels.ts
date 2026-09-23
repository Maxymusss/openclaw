/** Resolves thinking and reasoning together when a command or model turn consumes them. */
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { buildConfiguredModelCatalog } from "../../agents/model-selection-shared.js";
import { resolveReasoningDefault } from "../../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import {
  hasResolvedThinkingCatalogEntry,
  needsThinkHydration,
} from "../../agents/thinking-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import {
  formatThinkingLevels,
  resolveThinkingDefaultForModel,
  resolveThinkingSelectionForModel,
} from "../thinking.js";
import type { ReasoningLevel, ThinkLevel } from "../thinking.js";
import {
  findSelectedCatalogEntry,
  type RuntimeModelNormalization,
} from "./model-runtime-normalization.js";
import type { createModelSelectionState } from "./model-selection.js";

export type ReplyModelLevelSelection = {
  provider: string;
  model: string;
  agentRuntime?: string | null;
  thinkLevel?: ThinkLevel;
  thinkingExplicit: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningExplicit: boolean;
};

type ReplyModelLevels = {
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
};

export type ReplyThinkingPreparation = {
  agentId: string;
  provider: string;
  model: string;
  agentRuntime: string;
  catalog: ModelCatalogEntry[];
  allowedModelCatalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel: string;
  normalization: RuntimeModelNormalization;
  configuredThinkingDefault: ThinkLevel | undefined;
};

/** Data only: queued turns never retain an auth store, reader, or selection closure. */
export type DeferredReplyModelLevels = {
  selection: ReplyModelLevelSelection;
  thinking: ReplyThinkingPreparation;
  explicitThink?: boolean;
};

export type ReplyModelLevelResolver = () => Promise<ReplyModelLevels>;

type PreparedReplyModelLevelResolver = ReplyModelLevelResolver & {
  readonly selection: ReplyModelLevelSelection;
  defer: () => DeferredReplyModelLevels;
};

/** Commands and admitted model turns use the same capability owner and visibility projection. */
export async function resolveReplyThinkingCatalog(params: {
  cfg: OpenClawConfig;
  agentId: string;
  preparation: ReplyThinkingPreparation;
}) {
  const { preparation } = params;
  let catalog = preparation.catalog;
  if (
    needsThinkHydration(catalog, preparation.provider, preparation.model, preparation.agentRuntime)
  ) {
    const { loadProviderScopedThinkingCatalog } =
      await import("../../agents/model-catalog.runtime.js");
    const prepared = await loadProviderScopedThinkingCatalog({
      config: params.cfg,
      agentId: params.agentId,
      provider: preparation.provider,
      model: preparation.model,
      agentRuntime: preparation.agentRuntime,
    });
    if (findSelectedCatalogEntry({ ...preparation, catalog: prepared })) {
      catalog = createModelVisibilityPolicy({
        cfg: params.cfg,
        catalog: prepared,
        defaultProvider: preparation.defaultProvider,
        defaultModel: { provider: preparation.defaultProvider, model: preparation.defaultModel },
        agentId: params.agentId,
        ...preparation.normalization,
      }).catalog;
    }
  }
  return catalog.length > 0 ? catalog : undefined;
}

/** Consume original reply intent only after the model owner admitted the selected profile. */
export async function resolveDeferredReplyModelLevels(params: {
  cfg: OpenClawConfig;
  agentId: string;
  deferred: DeferredReplyModelLevels;
}) {
  const { selection, thinking, explicitThink } = params.deferred;
  const loadCatalog = createLazyPromise(() =>
    resolveReplyThinkingCatalog({
      cfg: params.cfg,
      agentId: params.agentId,
      preparation: thinking,
    }),
  );
  const requested =
    selection.thinkLevel ??
    thinking.configuredThinkingDefault ??
    resolveThinkingDefaultForModel({
      ...thinking,
      catalog: (await loadCatalog()) ?? buildConfiguredModelCatalog({ cfg: params.cfg }),
    });
  const reasoningLevel =
    !selection.reasoningExplicit &&
    selection.reasoningLevel === "off" &&
    requested === "off" &&
    !selection.thinkingExplicit
      ? resolveReasoningDefault({ ...thinking, catalog: await loadCatalog() })
      : selection.reasoningLevel;
  let catalog = thinking.allowedModelCatalog.length ? thinking.allowedModelCatalog : undefined;
  let resolved = resolveThinkingSelectionForModel({ ...thinking, level: requested, catalog });
  if (
    !resolved.supported ||
    (requested !== "off" && !hasResolvedThinkingCatalogEntry({ ...thinking, catalog }))
  ) {
    catalog = await loadCatalog();
    resolved = resolveThinkingSelectionForModel({ ...thinking, level: requested, catalog });
  }
  if (!resolved.supported && explicitThink) {
    return {
      kind: "reply" as const,
      reply: {
        text: `Thinking level "${requested}" is not supported for ${thinking.provider}/${thinking.model}. Use one of: ${formatThinkingLevels(thinking.provider, thinking.model, ", ", catalog, thinking.agentRuntime)}.`,
      },
    };
  }
  return {
    kind: "ready" as const,
    thinkLevel: resolved.supported ? requested : resolved.level,
    reasoningLevel,
    thinkingCatalog: catalog,
  };
}

export function createReplyModelLevelResolver(params: {
  selection: ReplyModelLevelSelection;
  modelState: Pick<
    Awaited<ReturnType<typeof createModelSelectionState>>,
    "resolveDefaultThinkingLevel" | "resolveDefaultReasoningLevel" | "prepareThinkingSelection"
  >;
}): PreparedReplyModelLevelResolver {
  const { selection, modelState } = params;
  const resolve = createLazyPromise(
    async () => {
      const { provider, model, agentRuntime } = selection;
      const resolvedThinkLevel =
        selection.thinkLevel ??
        (await modelState.resolveDefaultThinkingLevel({ provider, model, agentRuntime }));
      const resolvedReasoningLevel =
        !selection.reasoningExplicit &&
        selection.reasoningLevel === "off" &&
        resolvedThinkLevel === "off" &&
        !selection.thinkingExplicit
          ? await modelState.resolveDefaultReasoningLevel({ provider, model })
          : selection.reasoningLevel;
      return { resolvedThinkLevel, resolvedReasoningLevel };
    },
    { cacheRejections: true },
  );
  return Object.assign(resolve, {
    selection,
    defer: (): DeferredReplyModelLevels => ({
      selection: { ...selection },
      thinking: modelState.prepareThinkingSelection(selection),
    }),
  });
}

/** Retarget an automatic fallback without eagerly consuming the original reply defaults. */
export function retargetReplyModelLevelResolver(params: {
  resolver: PreparedReplyModelLevelResolver;
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  preserveThinkingLevel: boolean;
  thinkingExplicit: boolean;
  reasoningExplicit: boolean;
}): PreparedReplyModelLevelResolver {
  return createReplyModelLevelResolver({
    modelState: params.modelState,
    selection: {
      provider: params.modelState.provider,
      model: params.modelState.model,
      thinkLevel: params.preserveThinkingLevel ? params.resolver.selection.thinkLevel : undefined,
      thinkingExplicit: params.thinkingExplicit,
      reasoningLevel: params.reasoningExplicit ? params.resolver.selection.reasoningLevel : "off",
      reasoningExplicit: params.reasoningExplicit,
    },
  });
}
