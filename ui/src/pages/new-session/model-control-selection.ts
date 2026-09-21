import type { ChatAccountSelection, UserModelAccount } from "@openclaw/gateway-protocol";
import type { GatewayAgentRow, ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { chatModelUnavailableMessage } from "../../lib/chat/model-select-state.ts";
import type { ChatModelCatalogState } from "../chat/components/chat-model-controls.ts";
import {
  resolveDraftModelTarget,
  resolveDraftModelUnavailableReason,
  resolveDraftThinkingDefaults,
} from "./model-target.ts";

registerModelControlsEnglish();

export function resolveDraftModelPresentation(input: {
  agent?: GatewayAgentRow;
  defaults?: SessionsListResult["defaults"];
  model: string;
  agentRuntime?: string;
  catalog: ModelCatalogEntry[];
}) {
  const { agent, defaults, model, agentRuntime, catalog } = input;
  const agentDefaultModel = agent?.model?.primary;
  const defaultTarget = resolveDraftModelTarget(
    agentDefaultModel ?? defaults?.model,
    agentDefaultModel ? undefined : defaults?.modelProvider,
    catalog,
  );
  return {
    defaultTarget,
    selectedTarget: resolveDraftModelTarget(model, undefined, catalog, agentRuntime),
    thinkingDefaults: resolveDraftThinkingDefaults(defaultTarget, agent, defaults, catalog),
  };
}

type DraftModelAccess = {
  metadata: ChatModelCatalogState & { catalog: ModelCatalogEntry[]; displayOnly?: boolean };
  model: string;
  defaultModel?: string;
  agentRuntime?: string;
  restricted: boolean;
  pendingInitialModel?: string;
  pending: boolean;
  hasAccount: boolean;
  accountReady: boolean;
};

function blockedReason(input: DraftModelAccess, unavailable: string | undefined) {
  const { metadata, model, defaultModel, agentRuntime } = input;
  if (input.restricted) {
    if (input.pending || !metadata.hasSnapshot) {
      return metadata.status === "error"
        ? t("chat.modelControls.modelsUnavailable")
        : t("chat.modelControls.loadingModels");
    }
    const selected = model || defaultModel;
    if (
      input.pendingInitialModel ||
      (selected &&
        !resolveDraftModelTarget(selected, undefined, metadata.catalog, agentRuntime)?.entry)
    ) {
      return t("chat.modelControls.modelsUnavailable");
    }
  }
  if (
    agentRuntime &&
    metadata.hasSnapshot &&
    !resolveDraftModelTarget(model, undefined, metadata.catalog, agentRuntime)?.entry
  ) {
    return t("chat.modelControls.modelsUnavailable");
  }
  if (input.hasAccount) {
    if (metadata.status === "error") {
      return t("chat.modelControls.modelsUnavailable");
    }
    if (input.pending || !metadata.hasSnapshot) {
      return t("chat.modelControls.loadingModels");
    }
    if (!input.accountReady) {
      return unavailable ?? t("chat.modelControls.modelsUnavailable");
    }
  }
  return unavailable;
}

export function resolveDraftModelAccess(input: DraftModelAccess) {
  const { metadata, model, defaultModel, agentRuntime } = input;
  const unavailableReason =
    metadata.hasSnapshot && metadata.status !== "offline"
      ? resolveDraftModelUnavailableReason({
          model: model || defaultModel,
          catalog: metadata.catalog,
          agentRuntime,
        })
      : undefined;
  const target = resolveDraftModelTarget(model, undefined, metadata.catalog, agentRuntime);
  return {
    unavailableReason,
    blockedReason: blockedReason(input, chatModelUnavailableMessage(unavailableReason)),
    availableSelection:
      !input.pendingInitialModel &&
      metadata.status === "ready" &&
      !metadata.displayOnly &&
      Boolean(
        target?.entry &&
        target.entry.available !== false &&
        target.entry.manualSelectionAllowed !== false,
      ),
  };
}

export function isDraftModelAccountReady(input: {
  metadata: DraftModelAccess["metadata"] & { accountSelection?: ChatAccountSelection };
  account?: Pick<UserModelAccount, "authProfileId" | "provider"> & { model: string };
  agentRuntime?: string;
  current: boolean;
  pending: boolean;
}): boolean {
  if (!input.account) {
    return true;
  }
  const selection = input.metadata.accountSelection;
  if (
    !input.current ||
    input.pending ||
    input.metadata.status !== "ready" ||
    selection?.kind !== "personal" ||
    selection.authProfileId !== input.account.authProfileId
  ) {
    return false;
  }
  const target = resolveDraftModelTarget(
    input.account.model,
    undefined,
    input.metadata.catalog,
    input.agentRuntime,
  );
  return target?.entry?.available === true && target.provider === input.account.provider;
}
