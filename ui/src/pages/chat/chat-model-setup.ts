import type { GatewayAgentRow, GatewaySessionRow, ModelCatalogEntry } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import {
  chatModelUnavailableMessage,
  resolveChatModelSelectState,
  resolveChatModelUnavailableReason,
} from "../../lib/chat/model-select-state.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatComposerDisabledBanner } from "./components/chat-composer-types.ts";

type ChatModelSetupState = {
  catalog: boolean;
  connected: boolean;
  agentsLoaded: boolean;
  selectedAgentFound: boolean;
  agentModel?: string | null;
  selectedModelAvailable?: boolean;
};

export function requiresChatModelSetup(state: ChatModelSetupState): boolean {
  if (state.catalog || !state.connected || !state.agentsLoaded || !state.selectedAgentFound) {
    return false;
  }
  return !state.selectedModelAvailable && !state.agentModel?.trim();
}

export function resolveChatModelSetup(input: {
  state: Pick<
    ChatPageHost,
    | "hello"
    | "chatModelCatalog"
    | "chatModelRestricted"
    | "sessions"
    | "sessionKey"
    | "sessionsResult"
    | "connected"
  >;
  session?: GatewaySessionRow;
  agent?: GatewayAgentRow;
  agentsLoaded: boolean;
  catalog: boolean;
  onSetup: () => void;
}) {
  const { state, session, agent } = input;
  const model = resolveChatModelSelectState({
    modelRestricted: state.chatModelRestricted ?? state.hello?.auth?.modelRestricted,
    activeSession: session,
    agentDefaultModel: agent?.model?.primary,
    chatModelCatalog: state.chatModelCatalog,
    modelOverrides: state.sessions.state.modelOverrides,
    sessionKey: state.sessionKey,
    sessionsResult: state.sessionsResult,
  });
  return {
    modelUnavailableBanner: chatModelUnavailableBanner(
      model.currentOverride || model.defaultModel,
      session?.modelProvider,
      state.chatModelCatalog,
      input.onSetup,
    ),
    modelSetupRequired: requiresChatModelSetup({
      catalog: input.catalog,
      connected: state.connected,
      agentsLoaded: input.agentsLoaded,
      selectedAgentFound: agent !== undefined,
      agentModel: agent?.model?.primary,
      selectedModelAvailable: model.options.some(
        (option) => option.value === model.currentOverride && !option.disabled,
      ),
    }),
  };
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

function chatModelUnavailableBanner(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
  onSetup: () => void,
): ChatComposerDisabledBanner | undefined {
  const message = chatModelUnavailableMessage(
    resolveChatModelUnavailableReason(model, provider, catalog),
  );
  return message ? createChatModelSetupBanner(onSetup, message) : undefined;
}
