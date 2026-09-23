import type { GoalComposerController } from "./chat-composer-goal-mode.ts";
import { commitComposerDraft } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function createChatComposerSendHandler(params: {
  props: ChatComposerProps;
  state: ChatComposerState;
  humanDiscussion: boolean | undefined;
  canSubmitDraft: (draft: string) => boolean;
  goalComposer: GoalComposerController;
  syncComposerDraftAfterSend: (target: HTMLTextAreaElement | null) => void;
}) {
  const {
    props,
    state,
    humanDiscussion,
    canSubmitDraft,
    goalComposer,
    syncComposerDraftAfterSend,
  } = params;
  return (submissionAction?: Event, participation?: "agent" | "humans") => {
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
