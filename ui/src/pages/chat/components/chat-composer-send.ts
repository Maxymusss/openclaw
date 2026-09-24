import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import type { GoalComposerController } from "./chat-composer-goal-mode.ts";
import { clearPendingClearedSubmittedDraft, commitComposerDraft } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function createChatComposerSendHandler(params: {
  props: ChatComposerProps;
  state: ChatComposerState;
  humanDiscussion: boolean | undefined;
  participation?: "agent" | "humans";
  canSubmitDraft: (draft: string) => boolean;
  goalComposer: GoalComposerController;
  syncComposerDraftAfterSend: (target: HTMLTextAreaElement | null) => void;
}) {
  const {
    props,
    state,
    humanDiscussion,
    participation,
    canSubmitDraft,
    goalComposer,
    syncComposerDraftAfterSend,
  } = params;
  return (submissionAction?: Event) => {
    const draft = state.composerTextarea?.value ?? props.draft;
    if (!canSubmitDraft(draft)) {
      return;
    }
    state.composerComposing = false;
    state.composingDraft = null;
    commitComposerDraft(props, draft);
    props.onTypingChange?.(false);
    if (participation !== "humans" && !humanDiscussion && goalComposer.activateDraft(draft, true)) {
      return;
    }
    if (goalComposer.active) {
      void goalComposer.submit(submissionAction);
      return;
    }
    if (participation || humanDiscussion) {
      void props.onSend(undefined, submissionAction, participation ?? "humans");
    } else {
      void props.onSend(undefined, submissionAction);
    }
    syncComposerDraftAfterSend(state.composerTextarea);
  };
}

export function syncChatComposerDraftAfterSend(
  props: ChatComposerProps,
  state: ChatComposerState,
  draftKey: string,
  target: HTMLTextAreaElement | null,
) {
  state.emojiMenu.close();
  state.mentionMenu.close();
  const submittedDraft = target?.value ?? props.getDraft?.() ?? props.draft;
  const hostDraft = props.getDraft?.() ?? props.draft;
  const clearedSubmittedDraft =
    hostDraft === "" && submittedDraft !== "" && target?.value === submittedDraft;
  if (clearedSubmittedDraft) {
    state.pendingClearedSubmittedDraft = {
      key: draftKey,
      value: submittedDraft,
    };
  } else {
    clearPendingClearedSubmittedDraft(state, draftKey);
  }
  if (target && target.value !== hostDraft) {
    target.value = hostDraft;
    adjustTextareaHeight(target);
  }
}
