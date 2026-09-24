import type { UiSettings } from "./settings.ts";

const CHAT_SEND_SHORTCUTS = ["enter", "modifier-enter"] as const;
export type ChatSendShortcut = (typeof CHAT_SEND_SHORTCUTS)[number];

export function normalizeChatSendShortcut(value: unknown): ChatSendShortcut {
  return value === "modifier-enter" ? value : "enter";
}

const CHAT_FOLLOW_UP_MODES = ["queue", "steer"] as const;
export type ChatFollowUpMode = (typeof CHAT_FOLLOW_UP_MODES)[number];

export function normalizeChatFollowUpMode(value: unknown): ChatFollowUpMode {
  return normalizeChatFollowUpModeOverride(value) ?? "steer";
}

export function normalizeChatFollowUpModeOverride(value: unknown): ChatFollowUpMode | undefined {
  return value === "queue" || value === "steer" ? value : undefined;
}

type ChatSendPreferences = Pick<
  UiSettings,
  "chatSendShortcut" | "chatAutoSteer" | "chatFollowUpMode"
>;

/** Auto is persisted independently so toggling it never overwrites the manual baseline. */
export function loadChatSendPreferences(parsed: {
  [Key in keyof ChatSendPreferences]?: unknown;
}): ChatSendPreferences {
  return {
    chatSendShortcut: normalizeChatSendShortcut(parsed.chatSendShortcut),
    chatAutoSteer: parsed.chatAutoSteer === true,
    chatFollowUpMode: normalizeChatFollowUpModeOverride(parsed.chatFollowUpMode),
  };
}

export function serializeChatSendPreferences(next: ChatSendPreferences): ChatSendPreferences {
  const chatFollowUpMode = normalizeChatFollowUpModeOverride(next.chatFollowUpMode);
  return {
    ...(normalizeChatSendShortcut(next.chatSendShortcut) === "modifier-enter"
      ? { chatSendShortcut: "modifier-enter" as const }
      : {}),
    ...(next.chatAutoSteer === true ? { chatAutoSteer: true } : {}),
    ...(chatFollowUpMode ? { chatFollowUpMode } : {}),
  };
}
