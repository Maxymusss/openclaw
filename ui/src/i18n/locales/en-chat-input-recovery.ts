import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    inputRecovery: {
      recoveryTitle: "Requests that never started",
      recoveryDescription:
        "These requests did not reach the agent. They will not run automatically. Copy a request if you want to send it again.",
      interruptedStatus: "Interrupted · Not started",
      cancelledStatus: "Cancelled · Not started",
      emptyRecovery: "No requests need recovery on this page.",
      acceptedAt: "Received {date}",
      earlier: "Show earlier requests",
      latest: "Show latest requests",
    },
  },
} satisfies TranslationMap;

export const registerChatInputRecoveryEnglish = Object.assign(
  () => Object.assign(en.chat.inputRecovery, catalog.chat.inputRecovery),
  { catalog },
);
