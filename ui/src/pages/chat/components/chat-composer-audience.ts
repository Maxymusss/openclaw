import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { ChatRunControlsProps } from "./chat-composer-controls.ts";

export function renderChatAudienceAction(
  props: Pick<
    ChatRunControlsProps,
    "onAlternateAudience" | "canSend" | "sending" | "hasAttachments" | "humanDiscussion"
  >,
  hasComposedContent: boolean,
  sendDisabledReason: string | null | undefined,
) {
  return props.onAlternateAudience && hasComposedContent
    ? html`<button
        type="button"
        class="btn btn--sm"
        ?disabled=${!props.canSend || props.sending || props.hasAttachments || Boolean(sendDisabledReason)}
        @click=${props.onAlternateAudience}
        title=${props.humanDiscussion ? t("chat.messages.discussion.ask") : t("chat.messages.discussion.hint")}
      >
        ${props.humanDiscussion ? t("chat.messages.discussion.ask") : t("chat.messages.discussion.post")}
      </button>`
    : nothing;
}
