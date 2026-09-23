import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatItem, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { ChatMessageRecovery } from "./chat-message-recovery.ts";
import { buildPendingInputItems } from "./chat-pending-inputs.ts";
import { insertChatItemsByTimestamp, type TurnInsertionBounds } from "./chat-thread-items.ts";
import { chatItemStartsUserTurn } from "./chat-turn-boundary.ts";

export type PendingInputPlacement = {
  afterKey: string | null;
  historyAfterKey: string | null;
  beforeKey?: string;
};
// Retain observed positions across custody pages without growing for the session's lifetime.
const MAX_PENDING_INPUT_PLACEMENTS = 200;

type PendingInputProjection = {
  items: ChatItem[];
  bounds: TurnInsertionBounds;
  pendingBeforeKey?: string;
};

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
}): PendingInputProjection[] {
  const searchFiltering = Boolean(searchQuery?.trim());
  const projections: PendingInputProjection[] = [];
  const sourceKey = (key: string) => historySourceKeys.get(key) ?? key;
  const groups = pendingInputs.map((input) => ({
    input,
    pendingItems: buildPendingInputItems(
      [input],
      searchQuery,
      queue,
      workspaceSyncPendingRunIds,
      workerSetupPending,
      messageRecovery,
    ),
  }));
  const pendingKeys = new Set(
    groups.flatMap(({ pendingItems }) => pendingItems.map(({ key }) => key)),
  );
  for (const { input, pendingItems } of groups) {
    if (!pendingItems.length) {
      continue;
    }
    const previous = pendingInputPlacements.get(input.id);
    const afterIndex = previous?.afterKey
      ? items.findIndex((item) => item.key === previous.afterKey)
      : -1;
    let beforeIndex = previous?.beforeKey
      ? items.findIndex((item) => item.key === previous.beforeKey)
      : -1;
    const historyAfterIndex = previous
      ? Math.max(
          historyItems.findIndex(
            (item) => previous.afterKey !== null && item.key === sourceKey(previous.afterKey),
          ),
          historyItems.findIndex((item) => item.key === previous.historyAfterKey),
        )
      : -1;
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
    const pendingBeforeKey =
      previous?.beforeKey && pendingKeys.has(previous.beforeKey) ? previous.beforeKey : undefined;
    if ((!searchFiltering || !previous) && (!previous || anchorPresent)) {
      // Page absence is not consumption. Keep a bounded, recently observed
      // cache until the owning pane/session resets or older entries expire.
      pendingInputPlacements.delete(input.id);
      pendingInputPlacements.set(input.id, {
        afterKey,
        beforeKey: pendingBeforeKey ?? beforeKey,
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
    projections.push({ items: pendingItems, bounds, pendingBeforeKey });
  }
  return projections;
}

export function insertPendingInputProjections(
  items: ChatItem[],
  projections: PendingInputProjection[],
): void {
  const byKey = new Map(
    projections.flatMap((projection) =>
      projection.items.map((item) => [item.key, projection] as const),
    ),
  );
  const visited = new Set<PendingInputProjection>();
  const insert = (projection: PendingInputProjection) => {
    if (visited.has(projection)) {
      return;
    }
    visited.add(projection);
    // A local-send ceiling keeps the same key when custody replaces it. Insert
    // that anchor first so timestamp sorting cannot erase the observed order.
    const ceiling = projection.pendingBeforeKey;
    const pendingCeiling = ceiling ? byKey.get(ceiling) : undefined;
    if (pendingCeiling) {
      insert(pendingCeiling);
    }
    const pendingIndex = ceiling ? items.findIndex((item) => item.key === ceiling) : -1;
    const stableIndex = projection.bounds.beforeKey
      ? items.findIndex((item) => item.key === projection.bounds.beforeKey)
      : -1;
    const bounds =
      pendingIndex >= 0 && (stableIndex < 0 || pendingIndex < stableIndex)
        ? { ...projection.bounds, beforeKey: ceiling }
        : projection.bounds;
    const [message, ...notices] = projection.items;
    if (message) {
      insertChatItemsByTimestamp(items, [{ item: message, bounds }]);
      // Status is part of this custody record, not a separately clocked row.
      items.splice(items.indexOf(message) + 1, 0, ...notices);
    }
  };
  for (const projection of projections) {
    insert(projection);
  }
}
