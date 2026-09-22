import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatForeground = {
  chat: {
    foreground: {
      offline: "Reconnect before sending. Your draft has not been queued.",
      busy: "Wait for this turn to stop before sending another request. Your draft has not been queued.",
      history: "Wait for this conversation to finish loading before sending.",
      review:
        "This message will not send automatically. Review the conversation. If it is still needed, send it again as a new request.",
      command:
        "This command cannot be queued with foreground-only access. Your draft is unchanged.",
    },
  },
} satisfies TranslationMap;

export const registerChatForegroundEnglish = Object.assign(
  () => Object.assign(en.chat, enChatForeground.chat),
  { catalog: enChatForeground },
);
