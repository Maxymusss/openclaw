import { createAgentCleanupScope } from "../../agents/run-cleanup-timeout.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
} from "../../agents/run-termination.js";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import {
  isCompetingSessionWorkAdmissionActive,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import {
  SessionWorkCleanupUnconfirmedError,
  type SessionWorkAdmissionInterrupt,
} from "../../sessions/session-work-admission-interruption.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { formatForLog } from "../ws-log.js";
import { writePreRegisteredChatAbort } from "./chat-abort-authorization.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestContext } from "./types.js";

/** Keep the original terminal owner; unaccepted refusal never becomes a restart tombstone. */
export function createChatSendAdmissionInterrupt(params: {
  context: GatewayRequestContext;
  runId: string;
  attemptId: string;
  getAdmittedRunAbort: () => ReturnType<typeof registerChatAbortController> | undefined;
}): SessionWorkAdmissionInterrupt {
  return (reason) => {
    if (reason instanceof SessionWorkCleanupUnconfirmedError) {
      return;
    }
    const admittedRunAbort = params.getAdmittedRunAbort();
    const stopReason = isAgentRunDirectAbortReason(reason) ? "rpc" : "restart";
    if (!admittedRunAbort) {
      if (!params.context.chatRunState.hasAbortMarker(params.runId)) {
        writePreRegisteredChatAbort({
          context: params.context,
          runId: params.runId,
          stopReason,
          attemptId: params.attemptId,
        });
      }
    } else if (!admittedRunAbort.controller.signal.aborted) {
      // A later lifecycle drain must not overwrite the first abort reason.
      if (admittedRunAbort.entry) {
        admittedRunAbort.entry.abortStopReason = stopReason;
      }
      admittedRunAbort.controller.abort(
        stopReason === "rpc" ? reason : createAgentRunRestartAbortError(),
      );
    }
  };
}

/** The per-session hold survives logical settlement until tracked process/provider tails drain. */
export function runWithForegroundChatCleanup<T>(params: {
  admission: SessionWorkAdmissionLease;
  retain: () => () => void;
  logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
  publishReleased: () => void;
  run: () => Promise<T>;
}): Promise<T> {
  const cleanup = createAgentCleanupScope();
  return cleanup.run(() =>
    runWithAsyncWorkResources(async (onAcquired) => {
      const release = params.retain();
      onAcquired({
        releaseBeforeResultWhenIdle: true,
        release: () => {
          if (cleanup.outcome === "uncertain") {
            const refusal = params.admission.refuseNewWork(
              new SessionWorkCleanupUnconfirmedError(),
            );
            for (const error of refusal.interruptionErrors) {
              params.logGateway.warn(
                `Failed to notify refused session work: ${formatForLog(error)}`,
              );
            }
          }
          release();
          params.publishReleased();
        },
      });
      return await params.run();
    }),
  );
}

/** Queued and collected turns share the original session and caller admission until settlement. */
export function createChatSendWorkAdmission(params: {
  admission: Pick<SessionWorkAdmissionLease, "release">;
  releaseCallerAuthority?: () => void;
  logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
}) {
  let references = 1;
  let finishPendingInput: (() => void) | undefined;
  const release = () => {
    if (references === 0) {
      return;
    }
    references -= 1;
    if (references !== 0) {
      return;
    }
    try {
      finishPendingInput?.();
    } catch (error) {
      // The durable row remains recoverable; a failed disposition write must
      // not strand session/root drain ownership during shutdown.
      params.logGateway.warn(`Failed to finish pending chat input: ${formatForLog(error)}`);
    } finally {
      try {
        params.admission.release();
      } finally {
        params.releaseCallerAuthority?.();
      }
    }
  };
  const hold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      release();
    };
  };
  return {
    isActive: () => references > 0,
    release: hold(),
    retain: () => {
      if (references === 0) {
        throw new Error("cannot retain a released chat work admission");
      }
      references += 1;
      return hold();
    },
    setPendingInputCleanup: (finish: () => void) => {
      finishPendingInput = finish;
    },
  };
}

/** Rechecked inside the session writer barrier before exclusive input is admitted. */
export function assertChatSendExclusiveAdmission(
  request: NormalizedChatSendRequest,
  session: PreparedChatSendSession,
  foregroundOnly = false,
): void {
  if (!foregroundOnly && !request.goalOperation && !request.providerReviewAcknowledgment) {
    return;
  }
  const { storePath, sessionKey, backingSessionId, activeRunScopeKey } = session;
  if (
    isCompetingSessionWorkAdmissionActive(storePath, [sessionKey, backingSessionId]) ||
    hasPendingFollowupQueueWork([sessionKey, backingSessionId, activeRunScopeKey]) ||
    replyRunRegistry.isActive(activeRunScopeKey)
  ) {
    throw new Error(
      foregroundOnly
        ? "The foreground turn is still running. Wait for it to stop before sending a new request."
        : request.providerReviewAcknowledgment
          ? "The session still has active work. Review its status before continuing."
          : "goal-session-busy",
    );
  }
}
