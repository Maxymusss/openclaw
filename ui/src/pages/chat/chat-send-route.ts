import type { ChatHost } from "./chat-send-contract.ts";
import { waitForPendingChatSettings } from "./chat-send-queue-state.ts";
import { getPendingChatPickerPatch } from "./chat-session.ts";

export async function waitForSubmittedRoute(host: ChatHost, sessionKey: string): Promise<boolean> {
  const pending = getPendingChatPickerPatch(host, sessionKey);
  if (pending && !(await waitForPendingChatSettings(host, sessionKey, pending))) {
    return false;
  }
  return host.sessionKey === sessionKey;
}
