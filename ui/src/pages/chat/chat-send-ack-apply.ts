import { isNonTerminalAgentRunStatus } from "../../../../src/shared/agent-run-status.js";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { loadChatHistory } from "./chat-history.ts";
import type { ChatSendAck } from "./chat-send-ack.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import { adoptStartedChatRun, reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

/** The ACK can settle a submitted input without owning the active agent run. */
export function applyVisibleChatSendAck(params: {
  host: ChatHost;
  ack: ChatSendAck;
  prepared: ChatQueueItem;
  message: string;
  mentions: ChatQueueItem["mentions"];
  attachments: ChatAttachment[];
  startedAt: number;
  runId: string;
  sessionKey: string;
  retireOnAck: boolean;
  onCompleted: () => void;
}) {
  const {
    host,
    ack,
    prepared,
    message,
    mentions,
    attachments,
    startedAt,
    runId,
    sessionKey,
    retireOnAck,
    onCompleted,
  } = params;
  if (retireOnAck) {
    const projectionScope = readChatSessionProjectionScope(host, {
      sessionKey,
      agentId: prepared.agentId,
    });
    const projectedMessage = buildLocalUserMessage({
      ...prepared,
      text: message,
      mentions,
      attachments,
      createdAt: startedAt,
      runId,
    });
    if (projectedMessage) {
      reduceChatSessionProjection(
        host,
        { type: "sendPending", runId, message: projectedMessage },
        { scope: projectionScope },
      );
    }
    if (ack.runId !== runId) {
      reduceChatSessionProjection(
        host,
        { type: "sendAcknowledged", previousRunId: runId, runId: ack.runId },
        { scope: projectionScope },
      );
    }
  }
  if (ack.status === "posted") {
    // A committed discussion settles only its outbox row, never the active run.
    void loadChatHistory(host, { deferBranches: true });
  } else if (ack.status === "ok") {
    reconcileChatRunLifecycle(host, {
      outcome: "done",
      sessionStatus: "done",
      runId: ack.runId,
      sessionKey,
      clearLocalRun: true,
      clearChatStream: true,
      clearToolStream: true,
      publishRunStatus: false,
      armLocalTerminalReconcile: true,
    });
    onCompleted();
  } else if (isNonTerminalAgentRunStatus(ack.status)) {
    // Accepted steering/queued custody identifies the input, not a replacement
    // for the active model run. Only an explicit interrupt may replace it here;
    // otherwise live execution events own adoption when the queued turn starts.
    if (!host.chatRunId || prepared.queueMode === "interrupt") {
      adoptStartedChatRun(host, ack.runId, startedAt);
    }
    // Hydrate approved custody during setup without changing ordinary send
    // reconciliation or steering, whose ACK does not identify a new input.
    const setupHeld =
      prepared.sessionId &&
      host.sessionsResult?.sessions.some(
        (row) =>
          row.sessionId === prepared.sessionId &&
          ["requested", "provisioning", "syncing", "starting"].includes(row.placement?.state ?? ""),
      );
    if (prepared.queueMode !== "steer" && ack.messageSeq === undefined && setupHeld) {
      void loadChatHistory(host, { deferBranches: true });
    }
  }
}
