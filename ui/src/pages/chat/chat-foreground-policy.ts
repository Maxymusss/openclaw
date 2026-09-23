import { t } from "../../i18n/index.ts";
import { registerChatForegroundEnglish } from "../../i18n/locales/en-chat-foreground.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { isInitialChatHistoryUnavailable } from "./chat-history-state.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { updateQueuedMessagesForSession } from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { listStoredChatOutboxes, type StoredChatOutbox } from "./composer-persistence.ts";
import { isQueuedMessageBeingEdited } from "./queued-message-edit.ts";
import { hasDirectSessionRun, isChatBusy } from "./run-lifecycle.ts";

registerChatForegroundEnglish();

/** Adopt retained input once; receipt confirmation may subsequently return it to waiting-idle. */
export function adoptForegroundRetainedInputs(
  host: ChatHost,
  outbox: StoredChatOutbox,
): "unchanged" | "updated" | "failed" {
  if (!isForegroundChat(host)) {
    return "unchanged";
  }
  const owner = chatOutboxOwner(host);
  const updates = outbox.queue
    .filter(
      (item) =>
        !item.foregroundOnly &&
        !item.localCommandName &&
        !item.pendingRunId &&
        item.sendState !== "held" &&
        item.sendState !== "waiting-model" &&
        !isQueuedMessageBeingEdited(host, item.id) &&
        !owner.hasPendingDelivery(outbox, item),
    )
    .map((item) => ({
      id: item.id,
      update: (entry: ChatQueueItem): ChatQueueItem => ({
        ...entry,
        foregroundOnly: true,
        sendState: entry.sendState === "failed" ? "failed" : "unconfirmed",
        sendError: entry.sendError ?? t("chat.foreground.review"),
      }),
    }));
  if (updates.length === 0) {
    return "unchanged";
  }
  return updateQueuedMessagesForSession(host, updates) ? "updated" : "failed";
}

export function isForegroundChat(
  host: Pick<ChatHost, "hello">,
  item?: Pick<ChatQueueItem, "foregroundOnly">,
): boolean {
  // A later promotion must not revive input admitted with no automatic resumption.
  return item?.foregroundOnly === true || host.hello?.auth.executionPolicy === "foreground-only";
}

export function foregroundChatAdmissionError(
  host: ChatHost,
  item?: Pick<ChatQueueItem, "foregroundOnly"> & Partial<Pick<ChatQueueItem, "id">>,
): string | null {
  if (!isForegroundChat(host, item)) {
    return null;
  }
  if (!host.connected || !host.client) {
    return t("chat.foreground.offline");
  }
  const ownsAnotherDelivery = listStoredChatOutboxes(host).some(
    (outbox) =>
      visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) &&
      outbox.queue.some(
        (row) => row.id !== item?.id && chatOutboxOwner(host).hasPendingDelivery(outbox, row),
      ),
  );
  if (isChatBusy(host) || hasDirectSessionRun(host) || ownsAnotherDelivery) {
    return t("chat.foreground.busy");
  }
  if (host.chatLoading || isInitialChatHistoryUnavailable(host)) {
    return t("chat.foreground.history");
  }
  return null;
}
