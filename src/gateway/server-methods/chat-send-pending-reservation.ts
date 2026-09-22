import { resolveChatRunExpiresAtMs } from "../chat-abort.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import { readPreRegisteredRun } from "./chat-abort-authorization.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { normalizeOptionalChatText, normalizeUnknownChatText } from "./chat-text-normalization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Capture one attempt without publishing it until the admission owner has rechecked retries. */
export function createChatSendPendingReservation(
  {
    request,
    session,
    context,
    client,
  }: {
    request: NormalizedChatSendRequest;
    session: PreparedChatSendSession;
    context: Pick<GatewayRequestHandlerOptions["context"], "dedupe">;
    client: GatewayRequestHandlerOptions["client"];
  },
  pendingAttemptId: string,
) {
  const {
    clientRunId,
    pendingChatSendKey,
    sessionKey,
    rawSessionKey,
    backingSessionId,
    selectedAgent,
    now,
    timeoutMs,
  } = session;
  const { turnKind } = request;
  const readPendingReservation = () =>
    readPreRegisteredRun({
      key: pendingChatSendKey,
      entry: context.dedupe.get(pendingChatSendKey),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
  const clearPendingChatSendReservation = () => {
    const pending = readPendingReservation();
    if (
      pending?.runId === clientRunId &&
      normalizeUnknownChatText(pending.payload.attemptId) === pendingAttemptId
    ) {
      context.dedupe.delete(pendingChatSendKey);
    }
  };
  return {
    readPendingReservation,
    clearPendingChatSendReservation,
    reserve: () => {
      context.dedupe.set(pendingChatSendKey, {
        ts: now,
        ok: true,
        requestIdentity: request.requestIdentity,
        payload: {
          runId: clientRunId,
          attemptId: pendingAttemptId,
          status: "accepted" as const,
          sessionKey,
          ...(backingSessionId ? { sessionId: backingSessionId } : {}),
          ...(rawSessionKey === sessionKey ? {} : { sessionKeyAliases: [rawSessionKey] }),
          ...(selectedAgent.agentId ? { agentId: selectedAgent.agentId } : {}),
          ownerConnId: normalizeOptionalChatText(client?.connId),
          ownerDeviceId: normalizeOptionalChatText(client?.connect?.device?.id),
          expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
          turnKind,
          ...(request.goalOperation
            ? { goalFingerprint: request.goalOperation.requestFingerprint }
            : {}),
        },
      });
    },
  };
}
