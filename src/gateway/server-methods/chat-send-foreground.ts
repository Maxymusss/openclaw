import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveForegroundRunDeadline } from "../../agents/timeout.js";
import { resolveTextCommand } from "../../auto-reply/commands-registry.js";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  captureForegroundRecoveryExpectation,
  type SessionForegroundRun,
} from "../../config/sessions/session-foreground-run.js";
import { writeSessionForegroundRun } from "../../config/sessions/session-foreground-store.js";
import { withSessionHistoryWorkerDatabase } from "../../config/sessions/session-transcript-worker-runtime.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { findRestartRecoveryUnsafeChatAdmissionHook } from "../../plugins/restart-recovery-hook-safety.js";
import { readOperatorExecutionPolicy } from "../../shared/operator-execution-policy.js";
import { isBrowserOperatorUiClient } from "../../utils/message-channel.js";
import { isChatStopCommandText } from "../chat-abort.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  terminalizeRestartSafeChatAdmission,
  type RestartSafeChatTerminalState,
} from "./chat-restart-recovery.js";
import { handleChatSendSetupError } from "./chat-send-dispatch-errors.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Bind one clock and original source before chat preparation can yield or own input. */
export async function withForegroundChatAuthority(
  options: GatewayRequestHandlerOptions,
  run: (options: GatewayRequestHandlerOptions) => Promise<void>,
): Promise<void> {
  const client = options.client;
  const inherited = client?.internal?.operatorRunAuthority;
  if (inherited) {
    assertAdmittedRunOperatorAuthority(inherited);
    inherited.assertCurrent();
  }
  const access = client?.internal?.operatorAccessAuthority;
  access?.assertCurrent();
  const restricted =
    readOperatorExecutionPolicy(inherited?.executionPolicy) ??
    readOperatorExecutionPolicy(access?.executionPolicy);
  if (
    !restricted ||
    (typeof options.params.message === "string" && isChatStopCommandText(options.params.message))
  ) {
    return await run(options);
  }
  const captured = captureGatewayOperatorRunAuthority(options);
  if (!captured || !client) {
    captured?.release();
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, "Operator authority is unavailable."),
    );
    return;
  }
  try {
    let boundOptions: GatewayRequestHandlerOptions;
    try {
      const runId = options.params.idempotencyKey;
      if (
        typeof runId !== "string" ||
        !runId.trim() ||
        (inherited?.foregroundRunId !== undefined && inherited.foregroundRunId !== runId)
      ) {
        throw new Error(
          "Foreground authority cannot start another turn; submit a new user request.",
        );
      }
      const deadlineAt = resolveForegroundRunDeadline({
        cfg: options.context.getRuntimeConfig(),
        nowMs: Date.now(),
        overrideMs:
          typeof options.params.timeoutMs === "number" ? options.params.timeoutMs : undefined,
        inheritedDeadlineAt: inherited?.foregroundDeadlineAt,
      });
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new Error("The foreground turn deadline has expired. Start a new request.");
      }
      const deadlineSignal = AbortSignal.timeout(remainingMs);
      const authority = createAdmittedRunOperatorAuthority({
        ...captured.authority,
        executionPolicy: restricted,
        foregroundRunId: runId,
        foregroundDeadlineAt: deadlineAt,
        signal: captured.authority.signal
          ? AbortSignal.any([captured.authority.signal, deadlineSignal])
          : deadlineSignal,
      });
      boundOptions = {
        ...options,
        client: { ...client, internal: { ...client.internal, operatorRunAuthority: authority } },
      };
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, error instanceof Error ? error.message : String(error)),
      );
      return;
    }
    await run(boundOptions);
  } finally {
    captured.release();
  }
}

/** Unsupported ingress refuses before input custody, commands, hooks or runtime preparation. */
export function prepareForegroundChatAdmission(params: {
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
}): SessionForegroundRun | undefined {
  const authority = params.client?.internal?.operatorRunAuthority;
  if (authority?.executionPolicy !== "foreground-only" || params.request.stopCommand) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  authority.assertCurrent();
  const { request, session } = params;
  const entry = session.entry;
  const placement =
    entry &&
    params.context.workerSessionPlacementService?.getMany([entry.sessionId]).get(entry.sessionId);
  if (
    !isBrowserOperatorUiClient(request.clientInfo) ||
    !entry ||
    entry.incognito ||
    request.turnKind !== "main" ||
    request.goalOperation ||
    request.reconnectResumeRequested ||
    request.providerReviewAcknowledgment ||
    request.systemInputProvenance ||
    request.systemProvenanceReceipt ||
    request.suppressCommandInterpretation ||
    request.explicitOrigin ||
    request.p.deliver === true ||
    request.p.queueMode !== undefined ||
    resolveTextCommand(request.inboundMessage, session.cfg) ||
    (placement && placement.state !== "local") ||
    findRestartRecoveryUnsafeChatAdmissionHook("agent") ||
    resolveEffectiveAgentRuntime({
      cfg: session.cfg,
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      sessionEntry: entry,
      provider: session.resolvedSessionModel.provider,
      modelId: session.resolvedSessionModel.model,
    }) !== "openclaw"
  ) {
    throw new Error(
      "Foreground-only access requires a fresh Control UI message in an existing local OpenClaw thread. This request was not accepted.",
    );
  }
  if (
    authority.foregroundRunId !== session.clientRunId ||
    authority.foregroundDeadlineAt === undefined
  ) {
    throw new Error("Foreground turn authority is unavailable; submit a new request.");
  }
  return {
    runId: session.clientRunId,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision ?? null,
    gatewayLifecycleGeneration: getAgentEventLifecycleGeneration(),
    deadlineAt: authority.foregroundDeadlineAt,
  };
}

/** A retained stop receipt wins over reconnect and over later role promotion. */
export async function rejectStoppedForegroundRetry(params: {
  client: GatewayRequestHandlerOptions["client"];
  session: PreparedChatSendSession;
  request: NormalizedChatSendRequest;
  respond: GatewayRequestHandlerOptions["respond"];
  assertCurrent?: () => void;
}): Promise<boolean> {
  const { session, client, request } = params;
  const entry = session.entry;
  if (
    request.stopCommand ||
    !entry ||
    (client?.internal?.operatorRunAuthority?.executionPolicy !== "foreground-only" &&
      !Object.hasOwn(entry, "foregroundRun"))
  ) {
    return false;
  }
  const assertCurrent = () => {
    params.assertCurrent?.();
    client?.internal?.operatorRunAuthority?.assertCurrent();
  };
  assertCurrent();
  const scope = {
    agentId: session.agentId,
    sessionKey: session.sessionKey,
    storePath: session.storePath,
  };
  const receipt =
    entry.foregroundRun?.runId === session.clientRunId &&
    hasRestartRecoveryTerminalRun(entry, session.clientRunId)
      ? { kind: "stopped" as const }
      : await withSessionHistoryWorkerDatabase(
          toDatabaseOptions(resolveSqliteScope(scope)),
          (owner) =>
            owner.readForegroundStoppedReceipt({
              scope,
              expected: {
                runId: session.clientRunId,
                sessionId: entry.sessionId,
                lifecycleRevision: entry.lifecycleRevision ?? null,
              },
            }),
        ).catch(() => ({ kind: "unavailable" as const }));
  assertCurrent();
  if (receipt.kind === "absent") {
    // This permits an explicitly submitted request; it does not authorize an
    // automatic replay without the UI's positive pending-input custody.
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      receipt.kind === "stopped" ? ErrorCodes.FORBIDDEN : ErrorCodes.UNAVAILABLE,
      receipt.kind === "stopped"
        ? "This turn was stopped and was not resumed for security reasons. Send a new message to continue."
        : "The previous turn's receipt is unavailable. Review the thread before sending a new message.",
    ),
  );
  return true;
}

/** Keep admission and negative settlement bound to the same request-local row snapshot. */
export function createChatSendAdmissionLifecycle(params: {
  session: PreparedChatSendSession;
  foregroundAdmission: SessionForegroundRun | undefined;
  admittedSessionId: string;
  startedAt: number;
  warn: (message: string) => void;
}) {
  const { session, foregroundAdmission, admittedSessionId, startedAt, warn } = params;
  const { entry, agentId, sessionKey, storePath, clientRunId } = session;
  const expectedRecovery = captureForegroundRecoveryExpectation(entry);
  let foregroundMarkerAttempted = false;
  const terminalize = async (terminalState: RestartSafeChatTerminalState): Promise<boolean> => {
    if (foregroundMarkerAttempted && foregroundAdmission) {
      // Settlement consumes the original negative fact even if caller authority
      // expired. It cannot adopt a new row, writer or recovery claim.
      return await writeSessionForegroundRun({
        kind: "stop",
        scope: { agentId, sessionKey, storePath },
        admission: foregroundAdmission,
        expectedWriterRunId: entry?.activeWriterRunId ?? null,
        expectedRecovery,
        assertCurrent: () => {},
      });
    }
    return await terminalizeRestartSafeChatAdmission({
      admittedSessionId,
      clientRunId,
      sessionKey,
      startedAt,
      storePath,
      ...terminalState,
    });
  };
  return {
    terminalize,
    async admitForeground(assertCurrent: () => void): Promise<void> {
      if (!foregroundAdmission) {
        return;
      }
      // Mark attempted before the worker yields: a lost commit acknowledgement
      // still requires exact-original settlement, never a fresh execution retry.
      foregroundMarkerAttempted = true;
      const marked = await writeSessionForegroundRun({
        kind: "admit",
        scope: { agentId, sessionKey, storePath },
        admission: foregroundAdmission,
        expectedWriterRunId: entry?.activeWriterRunId ?? null,
        expectedRecovery,
        assertCurrent,
      });
      if (!marked) {
        throw new Error("Foreground restart custody changed before acceptance; refresh and retry.");
      }
    },
    async handleSetupError(
      options: Omit<
        Parameters<typeof handleChatSendSetupError>[0],
        "terminalizeRestartSafeAdmission"
      >,
    ): Promise<void> {
      if (foregroundMarkerAttempted) {
        await terminalize({ retryable: false, status: "failed" }).catch((error: unknown) => {
          warn(`Foreground input was not resumed; setup settlement failed: ${String(error)}`);
        });
      }
      await handleChatSendSetupError({
        ...options,
        admission: {
          ...options.admission,
          restartSafeAdmission: foregroundMarkerAttempted
            ? undefined
            : options.admission.restartSafeAdmission,
        },
        terminalizeRestartSafeAdmission: terminalize,
      });
    },
  };
}
