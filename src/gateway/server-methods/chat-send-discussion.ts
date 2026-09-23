import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { loadSessionEntry } from "../session-utils.js";
import { assertExpectedLeafActive } from "./chat-send-active-leaf.js";
import { respondChatSendAdmissionError } from "./chat-send-pre-admission.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Transcript custody only: never reserve, recover, steer, interrupt, or dispatch a run. */
export async function postChatDiscussion(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  respond: GatewayRequestHandlerOptions["respond"];
  assertCurrent: () => void;
}): Promise<void> {
  const { request, session, context, respond } = params;
  const sessionId = session.entry?.sessionId;
  if (!sessionId || sessionId !== request.p.sessionId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Human discussion requires the current existing session. Refresh and retry.",
      ),
    );
    return;
  }
  const assertCurrent = () => {
    params.assertCurrent();
    const cfg = context.getRuntimeConfig();
    const current = loadSessionEntry(session.sessionLoadKey, session.sessionLoadOptions, cfg);
    if (
      current.storePath !== session.storePath ||
      current.canonicalKey !== session.sessionKey ||
      session.sessionRoutingChanged(cfg)
    ) {
      throw new Error("Session routing changed before posting. Refresh and retry.");
    }
    const error = resolveSessionWorkStartError(session.sessionKey, current.entry, {
      allowPendingWorkspace: true,
      expectedSessionId: sessionId,
    });
    if (error) {
      throw new Error(error);
    }
    if (
      resolveSendPolicy({
        cfg,
        entry: current.entry,
        sessionKey: session.sessionKey,
        channel: sessionDeliveryChannel(current.entry),
        chatType: current.entry?.chatType,
      }) === "deny"
    ) {
      throw new Error("send blocked by session policy");
    }
    if (session.expectedLeafEntryId !== undefined) {
      assertExpectedLeafActive(current, session.agentId, session.expectedLeafEntryId, sessionId);
    }
  };
  const turn = createGatewayChatUserTurnController({
    admission: { sessionBinding: { sessionId } },
    client: params.client,
    request,
    session,
    startedAt: session.now,
    warn: (message) => context.logGateway.warn(message),
    mentionInbox: context.mentionInbox,
    assertOriginalInputCommit: assertCurrent,
  });
  try {
    assertCurrent();
    // Reuse durable input identity and hook custody, not the agent queue. The
    // immediate transcript append consumes this receipt; retries use its outcome.
    const staged = await turn.recorder.stageApproved?.({
      runId: session.clientRunId,
      assertCurrent,
      assertAdmittedCurrent: assertCurrent,
    });
    if (!staged && !turn.recorder.isPendingInputConsumed?.()) {
      throw new Error("Discussion was not recorded. Refresh and retry.");
    }
    if (
      turn.recorder.getPendingInputMessage?.()?.["__openclaw"]?.discussionRequestFingerprint !==
      turn.baseInput.discussionRequestFingerprint
    ) {
      throw new Error(
        "This message ID was already used for different input. Use a new message ID.",
      );
    }
    assertCurrent();
    const posted = await turn.persist();
    if (!posted) {
      throw new Error("Discussion was not recorded. Refresh and retry.");
    }
    params.assertCurrent();
    respond(true, {
      status: "posted",
      messageId: posted.messageId,
      messageSeq: posted.admission.activeMessagePosition + 1,
    });
    context.recordClientActivity?.(params.client);
  } catch (error) {
    turn.recorder.finishPendingInput?.("interrupted");
    respondChatSendAdmissionError(error, respond);
  }
}
