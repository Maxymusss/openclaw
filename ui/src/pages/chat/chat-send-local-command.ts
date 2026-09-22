import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { dispatchChatSlashCommand } from "./chat-commands.ts";
import {
  captureChatCommandComposerRecovery,
  clearSubmittedComposerState,
  settleChatCommandComposer,
  submittedCommandScopeIsVisible,
} from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { waitForSubmittedRoute } from "./chat-send-queue-state.ts";
import {
  recordNonTranscriptInputHistory,
  resetChatInputHistoryNavigation,
} from "./input-history.ts";
import { scheduleChatScroll } from "./scroll.ts";

export async function dispatchSubmittedLocalCommand({
  host,
  submittedSessionKey,
  commandName,
  commandArgs,
  waitsForPicker,
  messageOverride,
  previousDraft,
  previousMentions,
  attachmentsToSend,
  userMessage,
  options,
  sendResetMessage,
}: {
  host: ChatHost;
  submittedSessionKey: string;
  commandName: string;
  commandArgs: string;
  waitsForPicker: boolean;
  messageOverride: string | undefined;
  previousDraft: string;
  previousMentions: HumanMention[] | undefined;
  attachmentsToSend: ChatAttachment[];
  userMessage: string;
  options: { restoreDraft?: boolean; onLocalCommandSendRejected?: () => void } | undefined;
  sendResetMessage: Parameters<typeof dispatchChatSlashCommand>[3]["sendResetMessage"];
}): Promise<void> {
  if (waitsForPicker && !(await waitForSubmittedRoute(host, submittedSessionKey))) {
    return;
  }
  let prevDraft = messageOverride == null ? previousDraft : undefined;
  let recoveryComposer:
    | {
        draft: string;
        mentions?: readonly HumanMention[];
        attachments: ChatAttachment[];
      }
    | undefined;
  const recoveryScope = resolveUiConversationIdentity(host, submittedSessionKey);
  if (messageOverride == null) {
    recordNonTranscriptInputHistory(host, userMessage);
    if (waitsForPicker) {
      const cleared = clearSubmittedComposerState(
        host,
        previousDraft,
        attachmentsToSend,
        previousMentions,
      );
      prevDraft = cleared.previousDraft;
      if (cleared.previousDraft !== undefined) {
        recoveryComposer = {
          draft: cleared.previousDraft,
          mentions: cleared.previousMentions,
          attachments: cleared.previousAttachments ?? [],
        };
      }
    } else if (commandName !== "export-session") {
      recoveryComposer = {
        draft: previousDraft,
        mentions: previousMentions,
        attachments: attachmentsToSend,
      };
      host.chatMessage = "";
      host.chatMentions = [];
      host.chatAttachments = [];
      resetChatInputHistoryNavigation(host);
    }
  }
  const recovery = captureChatCommandComposerRecovery(host, recoveryScope, recoveryComposer);
  if (commandName === "steer" || commandName === "redirect") {
    scheduleChatScroll(host, true, false, { source: "manual" });
  }
  const dispatchResult = await dispatchChatSlashCommand(host, commandName, commandArgs, {
    previousDraft: prevDraft,
    restoreDraft: Boolean(messageOverride && options?.restoreDraft),
    sendResetMessage,
  });
  if (
    commandName === "export-session" &&
    dispatchResult === "completed" &&
    messageOverride == null &&
    submittedCommandScopeIsVisible(host, recovery)
  ) {
    clearSubmittedComposerState(host, previousDraft, attachmentsToSend, previousMentions, "all");
  }
  if (dispatchResult === "failed") {
    if (messageOverride != null || submittedCommandScopeIsVisible(host, recovery)) {
      options?.onLocalCommandSendRejected?.();
    }
  }
  if (dispatchResult === "failed" || dispatchResult === "cancelled") {
    settleChatCommandComposer(host, recovery, false, recovery.composer?.attachments);
  } else if (dispatchResult === "completed") {
    settleChatCommandComposer(host, recovery, true, recovery.composer?.attachments);
  }
}
