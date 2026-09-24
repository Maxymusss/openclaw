import { resolveChatRunExpiresAtMs } from "../chat-abort.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import { readPreRegisteredRun } from "./chat-abort-authorization.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { normalizeOptionalChatText, normalizeUnknownChatText } from "./chat-text-normalization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function createPendingChatSendReservationAccess(params: {
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  key: string;
  runId: string;
  attemptId: string;
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
}) {
  const read = () =>
    readPreRegisteredRun({
      key: params.key,
      entry: params.context.dedupe.get(params.key),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
  return {
    read,
    reserve: () => {
      const { context, request, session, attemptId } = params;
      context.dedupe.set(params.key, {
        ts: session.now,
        ok: true,
        requestIdentity: request.requestIdentity,
        payload: {
          runId: session.clientRunId,
          attemptId,
          status: "accepted",
          sessionKey: session.sessionKey,
          ...(session.backingSessionId ? { sessionId: session.backingSessionId } : {}),
          ...(session.rawSessionKey === session.sessionKey
            ? {}
            : { sessionKeyAliases: [session.rawSessionKey] }),
          ...(session.selectedAgent.agentId ? { agentId: session.selectedAgent.agentId } : {}),
          ownerConnId: normalizeOptionalChatText(params.client?.connId),
          ownerDeviceId: normalizeOptionalChatText(params.client?.connect?.device?.id),
          expiresAtMs: resolveChatRunExpiresAtMs({
            now: session.now,
            timeoutMs: session.timeoutMs,
          }),
          turnKind: request.turnKind,
          ...(request.goalOperation
            ? { goalFingerprint: request.goalOperation.requestFingerprint }
            : {}),
        },
      });
    },
    clear: () => {
      const pending = read();
      if (
        pending?.runId === params.runId &&
        normalizeUnknownChatText(pending.payload.attemptId) === params.attemptId
      ) {
        params.context.dedupe.delete(params.key);
      }
    },
  };
}
