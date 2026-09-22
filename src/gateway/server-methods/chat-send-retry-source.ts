import { readSessionSubmittedInput } from "../../config/sessions/session-accessor.js";
import { hasRestartRecoveryTerminalRun } from "./chat-restart-recovery.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type ChatSendRetryParams = {
  assertCurrent?: () => void;
  request: Pick<
    NormalizedChatSendRequest,
    "goalOperation" | "requestIdentity" | "rawMessage" | "mentions" | "workContext"
  >;
  session: Pick<
    PreparedChatSendSession,
    | "clientRunId"
    | "pendingChatSendKey"
    | "entry"
    | "restartSafeRequest"
    | "agentId"
    | "sessionKey"
    | "storePath"
  >;
  context: Pick<
    GatewayRequestHandlerOptions["context"],
    "dedupe" | "chatRunState" | "chatAbortControllers" | "chatQueuedTurns"
  >;
  respond: GatewayRequestHandlerOptions["respond"];
};

const preparedRetrySources = new WeakMap<
  ChatSendRetryParams["request"],
  {
    sessionId: string;
    target: string;
    message: Awaited<ReturnType<typeof readSessionSubmittedInput>>;
  }
>();

/** Prepare exact source evidence before entering synchronous admission and commit guards. */
export async function prepareChatSendRequestConflict(
  params: Omit<ChatSendRetryParams, "respond">,
): Promise<void> {
  params.assertCurrent?.();
  const sessionId = params.session.entry?.sessionId;
  if (!sessionId || params.request.goalOperation) {
    return;
  }
  const target = JSON.stringify([
    params.session.agentId,
    params.session.storePath,
    params.session.sessionKey,
    params.session.clientRunId,
  ]);
  const entries = [
    params.context.dedupe.get(`chat:${params.session.clientRunId}`),
    params.context.dedupe.get(params.session.pendingChatSendKey),
  ];
  if (
    entries.some((entry) => entry?.requestIdentity !== undefined) ||
    (params.session.entry?.restartRecoveryDeliverySourceRunId === params.session.clientRunId &&
      params.session.entry?.restartRecoveryDeliveryRequestFingerprint !== undefined)
  ) {
    return;
  }
  const knownRetry =
    entries.some(Boolean) ||
    params.session.entry?.restartRecoveryDeliverySourceRunId === params.session.clientRunId ||
    hasRestartRecoveryTerminalRun(params.session.entry, params.session.clientRunId) ||
    params.context.chatRunState.hasAbortMarker(params.session.clientRunId) ||
    params.context.chatAbortControllers.has(params.session.clientRunId) ||
    params.context.chatQueuedTurns?.has(params.session.clientRunId);
  if (!knownRetry) {
    return;
  }
  const message = await readSessionSubmittedInput(
    {
      agentId: params.session.agentId,
      sessionId,
      sessionKey: params.session.sessionKey,
      storePath: params.session.storePath,
    },
    `${params.session.clientRunId}:user`,
  );
  params.assertCurrent?.();
  if (
    params.session.entry?.sessionId !== sessionId ||
    target !==
      JSON.stringify([
        params.session.agentId,
        params.session.storePath,
        params.session.sessionKey,
        params.session.clientRunId,
      ])
  ) {
    throw new Error("Chat retry source target changed while preparing evidence");
  }
  preparedRetrySources.set(params.request, {
    sessionId,
    message,
    target,
  });
}

export function readPreparedChatSendRetrySource(request: ChatSendRetryParams["request"]) {
  return preparedRetrySources.get(request);
}
