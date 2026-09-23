import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeRoleForGrouping,
  resolveMessageRole,
  resolveMessageSender,
} from "../../../lib/chat/message-normalizer.ts";
import { agentRunFrameActiveStatusParts } from "../chat-agent-run-grouping.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  type buildCachedChatItems,
  chatItemsStructure,
  coalesceActivityRuns,
  coalesceAgentRunFrames,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
  getExpansionStateVersion,
  pruneAssistantMessageExpansions,
} from "../chat-thread.ts";
import { hasForwardedSource } from "../chat-turn-boundary.ts";
import type { StreamGroupPart } from "./chat-message.ts";
import { projectChatPositions } from "./chat-position-projection.ts";
import type { LoadedReplySource } from "./chat-reply-preview.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { latestTranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { projectTranscriptMessageIndex } from "./chat-transcript-message-index.ts";
import type { ChatTranscriptSession } from "./chat-transcript-session.ts";

type ChatItems = ReturnType<typeof buildCachedChatItems>;
type RenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];

function sameInputs(previous: readonly unknown[], next: readonly unknown[]) {
  return previous.length === next.length && previous.every((value, i) => Object.is(value, next[i]));
}

/** Keep candidate keys separate from the row model admitted by the unmount gate. */
export class TranscriptRowModel {
  private rows: readonly { key: string }[] = [];
  keys: readonly string[] = [];
  indexes = new Map<string, number>();

  project(rows: readonly { key: string }[]) {
    return rows === this.rows ||
      (rows.length === this.keys.length && rows.every((row, index) => row.key === this.keys[index]))
      ? this.keys
      : rows.map((row) => row.key);
  }

  commit(rows: readonly { key: string }[]) {
    this.rows = rows;
  }

  sync(keys: readonly string[]) {
    this.keys = Object.freeze(keys);
    this.indexes = new Map(keys.map((key, index) => [key, index]));
  }

  disconnect() {
    this.rows = [];
  }

  clear() {
    this.disconnect();
    this.keys = [];
    this.indexes.clear();
  }
}

function projectItems(
  chatItems: ChatItems,
  props: ChatThreadProps,
  searchActive: boolean,
  expandedToolCards: Map<string, boolean>,
) {
  const semanticItems = coalesceActivityRuns(
    collapseCompletedTurnWork(coalesceStreamRuns(chatItems), {
      sessionKey: props.sessionKey,
      runWorking: Boolean(props.runWorking),
      searchActive,
      session: props.selectedSession,
    }),
    { searchActive },
  );
  const collapsedItems = coalesceAgentRunFrames(semanticItems, { searchActive });
  const activeContinuations = new Map<string, StreamGroupPart[]>();
  const transcriptItems = collapsedItems.filter((item, index) => {
    const previous = collapsedItems[index - 1];
    const parts =
      item.kind === "stream-run" && item.parts.every((part) => part.kind === "reading-indicator")
        ? item.parts
        : item.kind === "agent-run-frame"
          ? agentRunFrameActiveStatusParts(item)
          : undefined;
    const runId =
      item.kind === "stream-run" || item.kind === "agent-run-frame" ? item.runId : undefined;
    if (
      previous?.kind !== "group" ||
      !parts ||
      !assistantGroupCanOwnActiveRunStatus(previous) ||
      (previous.runId !== undefined && runId !== undefined && previous.runId !== runId)
    ) {
      return true;
    }
    // Keep the still-running status with its reply rather than a second row.
    activeContinuations.set(previous.key, parts);
    return false;
  });
  const loadedReplySources = new Map<string, LoadedReplySource>();
  const messageIndex = projectTranscriptMessageIndex(
    transcriptItems,
    expandedToolCards,
    props,
    loadedReplySources,
  );
  const positionIndex = projectChatPositions(
    transcriptItems,
    expandedToolCards,
    messageIndex.messageRowKeysById,
  );
  const rows: TranscriptRow<RenderItem>[] = [];
  for (const item of transcriptItems) {
    rows.push({ kind: "item", key: item.key, item });
    if (item.kind === "work-group" && expandedToolCards.get(item.key)) {
      for (const group of item.groups) {
        rows.push({ kind: "item", key: `${item.key}:${group.key}`, item: group });
      }
    }
  }
  const liveIndex = chatItemsStructure(chatItems)?.liveStreamIndex ?? -1;
  const live = chatItems[liveIndex];
  let currentLive = live;
  const liveSlots: { parts: StreamGroupPart[]; index: number }[] = [];
  let liveRow: RenderItem | undefined;
  for (const item of collapsedItems) {
    const parts = item.kind === "agent-run-frame" ? item.parts : [item];
    for (const part of parts) {
      if (part.kind === "stream-run") {
        const index = part.parts.findIndex((candidate) => candidate === live);
        if (index >= 0) {
          liveSlots.push({ parts: part.parts, index });
          liveRow = item;
        }
      }
    }
  }
  return {
    transcriptItems,
    rows,
    activeContinuations,
    loadedReplySources,
    ...messageIndex,
    positionIndex,
    workingIndicator: chatItems.find((item) => item.kind === "reading-indicator"),
    hasForwardedGroups: chatItems.some((item) => item.kind === "group" && hasForwardedSource(item)),
    announcement: latestTranscriptAnnouncement(collapsedItems),
    refreshLiveStream() {
      const next = chatItems[liveIndex];
      if (next === currentLive || next?.kind !== "stream" || liveSlots.length === 0) {
        return true;
      }
      if (!positionIndex.refreshLiveStream(next)) {
        return false;
      }
      for (const slot of liveSlots) {
        slot.parts[slot.index] = next;
      }
      currentLive = next;
      if (this.announcement?.key === next.key && liveRow) {
        this.announcement = latestTranscriptAnnouncement([liveRow]);
      }
      return true;
    },
  };
}

class TranscriptDerivation {
  private historyInputs: readonly unknown[] = [];
  private senderInputs: readonly unknown[] = [];
  private showOwnSenderName = false;
  private inputs: readonly unknown[] = [];
  private expansionVersion = 0;
  private items: ReturnType<typeof projectItems> | undefined;

  prepareHistory(props: ChatThreadProps, transcript: ChatTranscriptSession) {
    const expanded = transcript.expandedAssistantMessages;
    const historyInputs = [
      props.messages,
      props.toolMessages,
      props.pendingInputs,
      props.fullMessageAgentId,
      expanded,
      getExpansionStateVersion(expanded),
    ];
    if (!sameInputs(this.historyInputs, historyInputs)) {
      if (expanded.size > 0) {
        pruneAssistantMessageExpansions(expanded, props.fullMessageAgentId, [
          ...props.messages,
          ...props.toolMessages,
          ...(props.pendingInputs ?? []).map((input) => input.message),
        ]);
      }
      this.historyInputs = historyInputs;
    }
    const participants =
      props.selectedSession?.expandedParticipants ?? props.selectedSession?.participants;
    const senderInputs = [participants, props.messages, props.pendingInputs, props.userId];
    if (!sameInputs(this.senderInputs, senderInputs)) {
      const isPeer = (message: unknown) => {
        if (normalizeRoleForGrouping(resolveMessageRole(message)) !== "user") {
          return false;
        }
        const sender = resolveMessageSender(
          asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]),
        );
        return Boolean(
          sender && !(sender.identity?.type === "profile" && sender.identity.id === props.userId),
        );
      };
      // Search and paging must not turn a retained shared conversation into a solo one.
      this.showOwnSenderName = Boolean(
        participants?.some(
          ({ identity }) =>
            identity.type !== "agent" &&
            !(identity.type === "profile" && identity.id === props.userId),
        ) ||
        props.messages.some(isPeer) ||
        props.pendingInputs?.some((input) => isPeer(input.message)),
      );
      this.senderInputs = senderInputs;
    }
    return this.showOwnSenderName;
  }

  project(
    chatItems: ChatItems,
    props: ChatThreadProps,
    searchActive: boolean,
    expanded: Map<string, boolean>,
  ) {
    const session = props.selectedSession;
    const structure = chatItemsStructure(chatItems);
    const inputs = [
      structure,
      props.sessionKey,
      Boolean(props.runWorking),
      searchActive,
      session?.key,
      session?.lastRunId,
      session?.status,
      session?.runtimeMs,
      expanded,
      props.assistantName,
      props.userId,
      props.userName,
      props.replyMessageAccess?.navigationId,
    ];
    // Reuse requires the builder's recorded structure; absent facts never prove stability.
    if (
      structure &&
      this.items &&
      this.expansionVersion === getExpansionStateVersion(expanded) &&
      sameInputs(this.inputs, inputs) &&
      this.items.refreshLiveStream()
    ) {
      return this.items;
    }
    this.items = projectItems(chatItems, props, searchActive, expanded);
    // Reply navigation can expand work while producing its row and anchor maps.
    this.expansionVersion = getExpansionStateVersion(expanded);
    this.inputs = inputs;
    return this.items;
  }
}

// Presentation lifetime owns this single snapshot; disposed sessions release
// history, rows, reply sources, and indexes together.
const derivations = new WeakMap<ChatTranscriptSession, TranscriptDerivation>();

export function getTranscriptDerivation(transcript: ChatTranscriptSession) {
  let derivation = derivations.get(transcript);
  if (!derivation) {
    derivation = new TranscriptDerivation();
    derivations.set(transcript, derivation);
  }
  return derivation;
}

export function releaseTranscriptDerivation(transcript: ChatTranscriptSession) {
  derivations.delete(transcript);
}
