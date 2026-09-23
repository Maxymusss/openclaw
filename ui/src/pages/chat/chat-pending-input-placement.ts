import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatItem, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { ChatMessageRecovery } from "./chat-message-recovery.ts";
import { buildPendingInputItems } from "./chat-pending-inputs.ts";
import type { ChatProjection } from "./chat-thread-items.ts";
import { chatItemStartsUserTurn } from "./chat-turn-boundary.ts";

export type PendingInputPlacement = {
  afterKey: string | null;
  historyAfterKey: string | null;
  beforeKey?: string;
};
// Retain observed positions across custody pages without growing for the session's lifetime.
const MAX_PENDING_INPUT_PLACEMENTS = 200;

export function projectPendingInputItems({
  pendingInputs,
  items,
  historyItems,
  historySourceKeys,
  pendingInputPlacements,
  searchQuery,
  queue,
  workspaceSyncPendingRunIds,
  workerSetupPending,
  messageRecovery,
}: {
  pendingInputs: ChatPendingInputsPage["items"];
  items: ChatItem[];
  historyItems: ChatItem[];
  historySourceKeys: ReadonlyMap<string, string>;
  pendingInputPlacements: Map<string, PendingInputPlacement>;
  searchQuery?: string;
  queue?: ChatQueueItem[];
  workspaceSyncPendingRunIds?: readonly string[];
  workerSetupPending?: boolean;
  messageRecovery?: ChatMessageRecovery;
}): ChatProjection[] {
  const searchFiltering = Boolean(searchQuery?.trim());
  const projections: ChatProjection[] = [];
  const sourceKey = (key: string) => historySourceKeys.get(key) ?? key;
  for (const input of pendingInputs) {
    const pendingItems = buildPendingInputItems(
      [input],
      searchQuery,
      queue,
      workspaceSyncPendingRunIds,
      workerSetupPending,
      messageRecovery,
    );
    const previous = pendingInputPlacements.get(input.id);
    const afterIndex = previous?.afterKey
      ? items.findIndex((item) => item.key === previous.afterKey)
      : -1;
    let beforeIndex = previous?.beforeKey
      ? items.findIndex((item) => item.key === previous.beforeKey)
      : -1;
    let historyAfterIndex = previous
      ? historyItems.findIndex(
          (item) => previous.afterKey !== null && item.key === sourceKey(previous.afterKey),
        )
      : -1;
    if (previous && historyAfterIndex < 0) {
      historyAfterIndex = historyItems.findIndex((item) => item.key === previous.historyAfterKey);
    }
    const historyFloorPresent = historyAfterIndex >= 0 || previous?.historyAfterKey === null;
    const anchorPresent =
      historyFloorPresent || previous?.afterKey === null || afterIndex >= 0 || beforeIndex >= 0;
    if (previous && anchorPresent) {
      // Canonical history owns the turn ceiling. Rendered keys additionally
      // preserve local sends, while source anchors survive hidden/lifted rows.
      const historyBeforeKey = previous.beforeKey ? sourceKey(previous.beforeKey) : undefined;
      let historyBeforeIndex = historyBeforeKey
        ? historyItems.findIndex((item) => item.key === historyBeforeKey)
        : -1;
      if (historyBeforeIndex < 0 && historyFloorPresent) {
        historyBeforeIndex = historyItems.findIndex(
          (item, index) => index > historyAfterIndex && chatItemStartsUserTurn(item),
        );
      }
      if (historyBeforeIndex >= 0 || historyFloorPresent) {
        const ceiling = historyBeforeIndex < 0 ? historyAfterIndex + 1 : historyBeforeIndex;
        const precedingKeys = new Set(historyItems.slice(0, ceiling).map((item) => item.key));
        const followingKeys = new Set(
          historyBeforeIndex < 0
            ? []
            : historyItems.slice(historyBeforeIndex).map((item) => item.key),
        );
        const visibleFloor = Math.max(
          afterIndex,
          items.findLastIndex((item) => precedingKeys.has(sourceKey(item.key))),
        );
        beforeIndex = items.findIndex(
          (item, index) =>
            followingKeys.has(sourceKey(item.key)) ||
            (index > visibleFloor &&
              !precedingKeys.has(sourceKey(item.key)) &&
              chatItemStartsUserTurn(item)),
        );
      } else if (beforeIndex < 0) {
        beforeIndex = items.findIndex(
          (item, index) => index > afterIndex && chatItemStartsUserTurn(item),
        );
      }
    }
    // Initially custody follows visible history. Once observed, later user turns
    // cannot move it; only the preceding assistant turn can continue above it.
    const afterKey = items[beforeIndex < 0 ? items.length - 1 : beforeIndex - 1]?.key ?? null;
    const beforeKey = beforeIndex < 0 ? undefined : items[beforeIndex]?.key;
    if (!searchFiltering && (!previous || anchorPresent)) {
      // Page absence is not consumption. Keep a bounded, recently observed
      // cache until the owning pane/session resets or older entries expire.
      pendingInputPlacements.delete(input.id);
      pendingInputPlacements.set(input.id, {
        afterKey,
        beforeKey,
        // Lifted previews can own the rendered floor without being history rows.
        historyAfterKey: previous ? previous.historyAfterKey : (historyItems.at(-1)?.key ?? null),
      });
      if (pendingInputPlacements.size > MAX_PENDING_INPUT_PLACEMENTS) {
        const oldest = pendingInputPlacements.keys().next().value;
        if (oldest !== undefined) {
          pendingInputPlacements.delete(oldest);
        }
      }
    }
    const bounds = {
      ...(afterKey ? { afterKey } : {}),
      ...(beforeKey ? { beforeKey } : {}),
    };
    projections.push(...pendingItems.map((item) => ({ item, bounds })));
  }
  return projections;
}
