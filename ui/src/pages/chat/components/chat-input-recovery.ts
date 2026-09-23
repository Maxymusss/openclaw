import { html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { renderCopyButton } from "../../../components/copy-button.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatInputRecoveryEnglish } from "../../../i18n/locales/en-chat-input-recovery.ts";
import { messageClientSourcesLabel } from "../../../lib/chat/message-client-source.ts";
import { formatDateTimeMs } from "../../../lib/format.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  getChatPendingInputs,
  getChatRecoveryInputs,
  loadChatPendingInputs,
} from "../chat-pending-inputs.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { buildMessageItems } from "../chat-thread-items.ts";
import type { ChatProps } from "../chat-view.ts";
import { renderForwardedAttribution } from "./chat-forwarded-attribution.ts";
import { renderMessageGroupContent, resolveMessageGroupSenderLabel } from "./chat-message-group.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { assistantMediaPolicyKey } from "./chat-message-media.ts";
import "./chat-input-recovery.css";

registerChatInputRecoveryEnglish();

class ChatInputRecoveryPanel extends OpenClawLightDomElement {
  @property({ attribute: false }) recoveryContext: { chat: ChatProps; host: ChatPageHost } | null =
    null;

  protected override render() {
    return this.recoveryContext ? renderChatInputRecovery(this.recoveryContext) : nothing;
  }
}

if (!customElements.get("openclaw-chat-input-recovery")) {
  customElements.define("openclaw-chat-input-recovery", ChatInputRecoveryPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-input-recovery": ChatInputRecoveryPanel;
  }
}

/** Read-only content for the shared side-panel shell; custody owns membership and paging. */
export function renderChatInputRecovery(params: {
  chat: ChatProps;
  host: ChatPageHost;
}): TemplateResult {
  const { chat, host } = params;
  const view = getChatPendingInputs(host);
  const inputs = getChatRecoveryInputs(host);
  // Do not forward composer, retry, reply, or rewind actions to saved inputs.
  const options = {
    showReasoning: false,
    showToolCalls: false,
    presented: chat.presented,
    transcriptVisible: chat.presented,
    sessionKey: chat.sessionKey,
    agentId: chat.currentAgentId ?? chat.fullMessageAgentId,
    assistantName: chat.assistantName,
    userId: chat.userId,
    userName: chat.userName,
    onRequestUpdate: chat.onRequestUpdate,
    onOpenSidebar: chat.onOpenSidebar,
    onOpenWorkspaceFile: chat.onOpenWorkspaceFile,
    resourceBasePath: chat.resourceBasePath,
    mediaPolicyKey: assistantMediaPolicyKey(chat.selectedSession, chat.mediaPolicyEpoch),
    connectionEpoch: chat.connectionEpoch,
    assistantAttachmentAuthToken: chat.assistantAttachmentAuthToken,
    resolveArtifactDownload: chat.resolveArtifactDownload,
    onRequestOpenImage: chat.onRequestOpenImage,
    onOpenImage: chat.onOpenImage,
    onAssistantAttachmentLoaded: chat.onAssistantAttachmentLoaded,
    embedSandboxMode: chat.embedSandboxMode,
    allowExternalEmbedUrls: chat.allowExternalEmbedUrls,
    fetchLinkFavicon: chat.fetchLinkFavicon,
  } satisfies Parameters<typeof renderMessageGroupContent>[1];

  return html`
    <section class="chat-input-recovery" aria-label=${t("chat.inputRecovery.recoveryTitle")}>
      <p class="chat-input-recovery__description">${t("chat.inputRecovery.recoveryDescription")}</p>
      <div class="chat-input-recovery__items">
        ${repeat(
          inputs,
          (input) =>
            JSON.stringify([options.agentId, chat.sessionKey, host.currentSessionId, input.id]),
          (input) => {
            const groups = groupMessages(
              buildMessageItems([input.message], () => `recovery:${input.id}`),
            ).filter((item) => item.kind === "group");
            const text = prepareChatMessageRender(input.message).displayMarkdown;
            const acceptedAt = formatDateTimeMs(input.acceptedAt, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              timeZoneName: "short",
            });
            return html`
              <article class="chat-input-recovery__card" data-input-id=${input.id}>
                <header class="chat-input-recovery__header">
                  <div class="chat-input-recovery__identity">
                    ${groups.map(
                      (group) => html`
                        <span class="chat-input-recovery__author">
                          ${resolveMessageGroupSenderLabel(group, options)}
                        </span>
                        ${
                          group.sourceClients?.length && (group.sender || group.senderLabel)
                            ? html`<span class="chat-input-recovery__source">
                                ${messageClientSourcesLabel(group.sourceClients)}
                              </span>`
                            : nothing
                        }
                      `,
                    )}
                    <span class="chat-input-recovery__accepted">
                      ${t("chat.inputRecovery.acceptedAt", { date: acceptedAt })}
                    </span>
                  </div>
                  <span class="chat-input-recovery__badge" data-state=${input.state}>
                    ${t(
                      input.state === "cancelled"
                        ? "chat.inputRecovery.cancelledStatus"
                        : "chat.inputRecovery.interruptedStatus",
                    )}
                  </span>
                  ${text.trim() ? renderCopyButton(text, t("common.copy")) : nothing}
                </header>
                <div class="chat-input-recovery__content">
                  ${groups.map(
                    (group) => html`
                      ${group.senderSession ? renderForwardedAttribution(group, { ...options, linkSource: false }) : nothing}
                      ${renderMessageGroupContent(group, options)}
                    `,
                  )}
                </div>
              </article>
            `;
          },
        )}
        ${
          inputs.length === 0
            ? html`<p class="chat-input-recovery__empty">
                ${t("chat.inputRecovery.emptyRecovery")}
              </p>`
            : nothing
        }
      </div>
      ${
        view?.error
          ? html`<p class="chat-input-recovery__error" role="status">${view.error}</p>`
          : nothing
      }
      <div class="chat-input-recovery__paging">
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${!host.connected || view?.loading || view?.page.nextBefore === undefined}
          @click=${() => void loadChatPendingInputs(host, view?.page.nextBefore)}
        >
          ${t("chat.inputRecovery.earlier")}
        </button>
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${!host.connected || view?.loading || view?.before === undefined}
          @click=${() => void loadChatPendingInputs(host)}
        >
          ${t("chat.inputRecovery.latest")}
        </button>
      </div>
    </section>
  `;
}
