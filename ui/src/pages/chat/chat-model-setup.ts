import type { GatewaySessionRow, ModelCatalogEntry } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import {
  chatModelUnavailableMessage,
  resolveChatModelUnavailableReason,
} from "../../lib/chat/model-select-state.ts";
import type { ChatComposerDisabledBanner } from "./components/chat-composer-types.ts";

type ChatModelSetupState = {
  catalog: boolean;
  connected: boolean;
  agentsLoaded: boolean;
  selectedAgentFound: boolean;
  agentModel?: string | null;
};

export function requiresChatModelSetup(state: ChatModelSetupState): boolean {
  if (state.catalog || !state.connected || !state.agentsLoaded || !state.selectedAgentFound) {
    return false;
  }
  return !state.agentModel?.trim();
}

export function createChatModelSetupBanner(
  onAction: () => void,
  text = t("modelSetup.required.body"),
): ChatComposerDisabledBanner {
  return {
    kind: "above-composer",
    text: `${text} ${t("modelSetup.commandHint")}`,
    actionLabel: t("modelSetup.required.action"),
    onAction,
  };
}

export function chatModelUnavailableBanner(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
  onSetup: () => void,
  placement?: GatewaySessionRow["placement"],
): ChatComposerDisabledBanner | undefined {
  const message = chatModelUnavailableMessage(
    resolveChatModelUnavailableReason(model, provider, catalog),
    placement?.state === "active" ? placement.inference : undefined,
  );
  return message ? createChatModelSetupBanner(onSetup, message) : undefined;
}
