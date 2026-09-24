import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import "../../../styles/chat/composer-audience.css";

/** Audience is draft-local presentation intent, never a session setting. */
export function resolveChatComposerAudience(
  props: ChatComposerProps,
  state: ChatComposerState,
  draftKey: string,
  draft: string,
  goalActive: boolean,
  requestUpdate: () => void,
): {
  participation: "agent" | "humans" | undefined;
  humanDiscussion: boolean;
  control: TemplateResult | typeof nothing;
} {
  const hasMentions = Boolean(props.mentions?.length);
  const humanReply = props.replyTarget?.participation === "humans";
  const visible = Boolean(props.discussionAvailable && !goalActive && (hasMentions || humanReply));
  const key = JSON.stringify([
    draftKey,
    props.currentSessionId,
    props.replyTarget?.messageId,
    props.queuedEdit?.editingId,
    hasMentions,
  ]);
  if (
    !visible ||
    state.audience?.key !== key ||
    state.audience.owner !== props.gatewayScope ||
    (state.audience.hasDraft && !draft.trim())
  ) {
    state.audience = { key, owner: props.gatewayScope, hasDraft: Boolean(draft.trim()) };
  }
  state.audience.hasDraft = Boolean(draft.trim());
  const participation = visible
    ? (state.audience.participation ?? (humanReply ? "humans" : "agent"))
    : undefined;
  const humanDiscussion = participation === "humans";
  const attachments = Boolean(props.attachments?.length);
  const control = visible
    ? html`<label
        class="field checkbox chat-composer-audience"
        title=${attachments ? t("chat.messages.discussion.textOnly") : t("chat.messages.discussion.hint")}
        @click=${(event: Event) => event.stopPropagation()}
        @pointerdown=${(event: Event) => event.stopPropagation()}
      >
        <input
          type="checkbox"
          .checked=${!humanDiscussion}
          ?disabled=${props.sending || !props.connected || !props.canSend || (attachments && !humanDiscussion)}
          @change=${(event: Event) => {
            const target = event.currentTarget;
            if (target instanceof HTMLInputElement) {
              state.audience = {
                key,
                owner: props.gatewayScope,
                hasDraft: Boolean(draft.trim()),
                participation: target.checked ? "agent" : "humans",
              };
              requestUpdate();
            }
          }}
        />
        <span>${t("chat.messages.discussion.runAgent")}</span>
      </label>`
    : nothing;
  return { participation, humanDiscussion, control };
}
