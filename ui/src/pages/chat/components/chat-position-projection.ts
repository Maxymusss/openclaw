import type { ChatItem, MessageGroup } from "../../../lib/chat/chat-types.ts";
import { resolveMessageVisibleContent } from "../../../lib/chat/message-visibility.ts";
import type { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";

type ChatPositionMarker = {
  id: string;
  role: "user" | "assistant";
  anchorId: string;
  message: unknown;
};

export type ChatPositionIndex = {
  markers: ChatPositionMarker[];
  /** Transcript order, including continuations after an intervening user steer. */
  markerIdsByMessageId: Map<string, string>;
};

type RenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];
type StreamItem = Extract<ChatItem, { kind: "stream" }>;

function streamPosition(part: StreamItem) {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: part.text }],
    timestamp: part.startedAt,
  };
  const { normalizedMessage, displayMarkdown } = prepareChatMessageRender(message);
  return {
    message,
    visible:
      resolveMessageVisibleContent(message, normalizedMessage) === "non-text" ||
      Boolean(displayMarkdown.trim()),
  };
}

export function projectChatPositions(
  items: readonly RenderItem[],
  expandedWork: ReadonlyMap<string, boolean>,
  messageRowKeysById: Map<string, string>,
) {
  const markers = new Map<string, ChatPositionMarker>();
  const markerIdsByMessageId = new Map<string, string>();
  let livePosition: { key: string; id: string; message: unknown; visible: boolean } | undefined;
  const add = (
    id: string,
    role: ChatPositionMarker["role"],
    messageId: string,
    message: unknown,
    rowKey: string,
  ) => {
    const marker = markers.get(id);
    if (marker) {
      marker.message = message;
    } else {
      markers.set(id, { id, role, anchorId: messageId, message });
    }
    markerIdsByMessageId.set(messageId, id);
    messageRowKeysById.set(messageId, rowKey);
  };
  const group = (item: MessageGroup, rowKey: string) => {
    if ((item.role !== "user" && item.role !== "assistant") || item.visibleContent === "none") {
      return;
    }
    for (const source of item.messages) {
      if (!source.hasVisibleContent) {
        continue;
      }
      const messageId = persistedMessageEntryId(source.message) ?? source.key;
      // A run can span frames, search matches, or a history page missing its user boundary.
      // Without run identity, retain the transcript's existing group boundary.
      const markerId =
        item.role === "user"
          ? messageId
          : item.runId
            ? `run:${item.runId}`
            : (persistedMessageEntryId(item.messages[0]?.message) ?? item.key);
      add(markerId, item.role, messageId, source.message, rowKey);
    }
  };
  const visit = (item: RenderItem, rowKey: string) => {
    if (item.kind === "group") {
      group(item, rowKey);
    } else if (item.kind === "agent-run-frame") {
      for (const part of item.parts) {
        visit(part, rowKey);
      }
    } else if (item.kind === "activity-run") {
      for (const part of item.groups) {
        group(part, rowKey);
      }
    } else if (item.kind === "work-group" && expandedWork.get(item.key)) {
      // Folded work has no mounted bubble to reveal. Its visible final reply owns the anchor.
      for (const part of item.groups) {
        group(part, rowKey === item.key ? `${item.key}:${part.key}` : rowKey);
      }
    } else if (item.kind === "stream-run") {
      for (const part of item.parts) {
        if (part.kind !== "stream") {
          continue;
        }
        const { message, visible } = streamPosition(part);
        const id = item.runId ? `run:${item.runId}` : item.key;
        if (part.isStreaming) {
          livePosition = { key: part.key, id, message, visible };
        }
        if (visible) {
          add(id, "assistant", part.key, message, rowKey);
        }
      }
    }
  };
  for (const item of items) {
    visit(item, item.key);
  }
  return {
    markers: [...markers.values()],
    markerIdsByMessageId,
    refreshLiveStream(part: StreamItem): boolean {
      if (!livePosition || livePosition.key !== part.key) {
        return false;
      }
      const next = streamPosition(part);
      if (next.visible !== livePosition.visible) {
        return false;
      }
      const marker = markers.get(livePosition.id);
      // A later continuation may own this run's preview. Refresh only the
      // live contribution, preserving the first anchor and later ownership.
      if (marker && marker.message === livePosition.message) {
        marker.message = next.message;
      }
      livePosition.message = next.message;
      return true;
    },
  };
}
