import { isModelIndependentChatCommand } from "../../lib/chat/commands.ts";
import type { ChatSendSubmitOptions } from "./chat-send-submit.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";

export function createChatPaneSendHandler(params: {
  canSend: boolean;
  modelRequiredReason?: string | null;
  getDraft: () => string;
  hasAttachments: () => boolean;
  continueCatalog?: () => void | Promise<void>;
  addSuggestion?: () => void | Promise<void>;
  send: (
    message?: string,
    options?: ChatSendSubmitOptions,
    event?: Event,
  ) => void | Promise<boolean | void>;
}): ChatComposerProps["onSend"] {
  return (followUpMode, event, participation) => {
    if (
      !params.canSend ||
      (params.modelRequiredReason &&
        (params.hasAttachments() || !isModelIndependentChatCommand(params.getDraft())))
    )
      return;
    if (params.continueCatalog) return params.continueCatalog();
    if (params.addSuggestion) return params.addSuggestion();
    return params.send(
      undefined,
      {
        ...(followUpMode ? { followUpMode } : {}),
        ...(participation ? { participation } : {}),
      },
      event,
    );
  };
}
