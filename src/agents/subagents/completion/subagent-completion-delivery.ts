import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import type { DeliveryQueueStoredStatus } from "../../../infra/delivery-queue-sqlite.kernel.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import { releaseSessionDeliveryClaim } from "../../../infra/session-delivery-queue-storage.js";
import {
  prepareClaimedSessionDelivery,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
  type SessionDeliverySettledOutcome,
} from "../../../infra/session-delivery-queue.records.js";
import type { OpenClawStateDatabaseOptions } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { RuntimeContextFragment } from "../../internal-runtime-context.js";
import { ensureDeliveryState } from "../registry/subagent-delivery-state.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  safeRemoveAttachmentsDir,
} from "../registry/subagent-registry-helpers.js";
import { loadPendingFinalDeliveryPayload } from "../registry/subagent-registry-lifecycle-delivery.js";
import type { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  admitSubagentCompletionDelivery,
  blockSubagentCompletionDelivery,
  publishCommittedRecords,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";
import { SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION } from "./subagent-completion-instructions.js";
import { resolveSubagentCompletionResultText } from "./subagent-completion-result.js";

const CLAIM_LEASE_MS = 125_000;
const MAX_DELIVERY_GENERATION = 10;
const CANONICAL_RESULT_PROMPT = `A completed subagent task is ready for parent review. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} The canonical result follows.`;
type CompletionDeliveryRecoveryResult = {
  ok: boolean;
  reason?: string;
  run?: SubagentRunRecord;
  duplicateRisk?: boolean;
};

/** Atomically admits a queue generation and publishes process mirrors only after commit. */
export function admitCorrelatedSubagentSessionDelivery(params: {
  runId: string;
  payload: Extract<QueuedSessionDeliveryPayload, { kind: "agentTurn" }>;
}): { id: string; claimed: boolean; status: DeliveryQueueStoredStatus } {
  const current = subagentRuns.get(params.runId);
  if (!current) {
    throw new Error(`subagent completion owner not found: ${params.runId}`);
  }
  const now = Date.now();
  const subagent = structuredClone(current);
  const delivery = ensureDeliveryState(subagent);
  const generation = delivery.generation ?? 1;
  const windowStartedAt = delivery.windowStartedAt ?? subagent.execution.endedAt ?? now;
  const deadlineAt = delivery.deadlineAt ?? windowStartedAt + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS;
  const generationSuffix = generation > 1 ? `:generation:${generation}` : "";
  const queueEntry = prepareClaimedSessionDelivery(
    {
      ...params.payload,
      idempotencyKey: `${params.payload.idempotencyKey ?? params.payload.messageId}${generationSuffix}`,
      messageId: `${params.payload.messageId}${generationSuffix}`,
      message: CANONICAL_RESULT_PROMPT,
      maxRetries: Number.MAX_SAFE_INTEGER,
      owner: {
        kind: "subagent_completion",
        runId: subagent.runId,
        taskId: subagent.taskRunId ?? subagent.runId,
        generation,
        deadlineAt,
      },
    },
    CLAIM_LEASE_MS,
    now,
  );
  Object.assign(delivery, {
    status: "in_progress" as const,
    disposition: "session_queued" as const,
    generation,
    queueId: queueEntry.id,
    windowStartedAt,
    deadlineAt,
    nextAttemptAt: queueEntry.availableAt,
    enqueuedAt: now,
  });
  delivery.payload ??= loadPendingFinalDeliveryPayload(subagent);
  const admission = admitSubagentCompletionDelivery({
    queueEntry,
    subagent,
  });
  publishCommittedRecords(subagent);
  return { id: queueEntry.id, ...admission };
}

export function resolveCorrelatedSubagentDelivery(
  queued: QueuedSessionDelivery,
): QueuedSessionDelivery & { runtimeContextFragments?: RuntimeContextFragment[] } {
  if (queued.kind !== "agentTurn" || queued.owner?.kind !== "subagent_completion") {
    return queued;
  }
  if (Date.now() >= queued.owner.deadlineAt) {
    throw new SessionDeliveryDeadLetteredError(
      "correlated subagent completion delivery deadline expired",
    );
  }
  const entry = subagentRuns.get(queued.owner.runId);
  if (
    !entry ||
    entry.delivery?.queueId !== queued.id ||
    entry.delivery.generation !== queued.owner.generation ||
    entry.delivery.deadlineAt !== queued.owner.deadlineAt
  ) {
    throw new SessionDeliveryDeferredError("correlated subagent delivery owner mismatch");
  }
  const result = resolveSubagentCompletionResultText(entry) ?? "(no output)";
  return {
    ...queued,
    message: `${CANONICAL_RESULT_PROMPT}\n\n${result}`,
    runtimeContextFragments: [
      { kind: "runtime-instruction", text: CANONICAL_RESULT_PROMPT },
      { kind: "conversation-data", text: result },
    ],
  };
}

export async function settleCorrelatedSubagentDelivery(
  queued: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
): Promise<void> {
  if (queued.kind !== "agentTurn" || queued.owner?.kind !== "subagent_completion") {
    return;
  }
  const current = subagentRuns.get(queued.owner.runId);
  if (
    !current ||
    current.delivery?.queueId !== queued.id ||
    current.delivery.generation !== queued.owner.generation
  ) {
    return;
  }
  const now = Date.now();
  const subagent = structuredClone(current);
  const delivery = ensureDeliveryState(subagent);
  if (outcome !== "recovered") {
    blockSubagentCompletionDelivery({
      subagent: current,
      reason: queued.lastError ?? "completion delivery failed",
      suspendedReason: "permanent_failure",
    });
    return;
  }
  Object.assign(delivery, {
    status: "delivered" as const,
    disposition: "delivered" as const,
    deliveredAt: now,
    announcedAt: now,
    lastError: undefined,
    nextAttemptAt: undefined,
    queueId: undefined,
  });
  delivery.payload = undefined;
  settleSubagentCompletionDelivery({ subagent });
  publishCommittedRecords(subagent);
  const { resumeSubagentRun } = await import("../registry/subagent-registry.js");
  resumeSubagentRun(subagent.runId);
}

export async function retrySubagentCompletionDelivery(
  runId: string,
  databaseOptions?: OpenClawStateDatabaseOptions,
): Promise<CompletionDeliveryRecoveryResult> {
  const current = subagentRuns.get(runId);
  if (!current || current.expectsCompletionMessage !== true) {
    return { ok: false, reason: "task has no recoverable subagent completion" };
  }
  const delivery = ensureDeliveryState(current);
  if (delivery.status === "in_progress" && delivery.queueId) {
    const queueContext = captureOpenClawStateWorkerContext();
    await releaseSessionDeliveryClaim(delivery.queueId, queueContext);
    await scheduleSessionDelivery(delivery.queueId, queueContext);
    return { ok: true, run: subagentRuns.get(runId) };
  }
  if (delivery.status !== "suspended") {
    return { ok: false, reason: "completion delivery is not blocked" };
  }
  const generation = (delivery.generation ?? 1) + 1;
  if (generation > MAX_DELIVERY_GENERATION) {
    return { ok: false, reason: "completion delivery redrive limit reached" };
  }
  const now = Date.now();
  const redrive = structuredClone(current);
  Object.assign(ensureDeliveryState(redrive), {
    status: "pending" as const,
    disposition: "retryable" as const,
    generation,
    queueId: undefined,
    windowStartedAt: now,
    deadlineAt: now + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
    suspendedAt: undefined,
    suspendedReason: undefined,
    attemptCount: 0,
    lastDropReason: undefined,
    lastError: undefined,
    nextAttemptAt: undefined,
  });
  redrive.cleanupHandled = false;
  // An explicit retry is a fresh admitted operation, never a revival of the expired source.
  const continuation = captureOperatorToolGatewayContinuationContext();
  let transferred = false;
  try {
    settleSubagentCompletionDelivery({ subagent: redrive, databaseOptions });
    // The committed new generation owns the caller before publication can schedule delivery.
    if (continuation?.operatorAuthority) {
      subagentRuns.bindCompletionAuthority(current, continuation);
      transferred = true;
    }
    publishCommittedRecords(redrive);
    const { resumeSubagentRun } = await import("../registry/subagent-registry.js");
    resumeSubagentRun(redrive.runId);
    return { ok: true, run: subagentRuns.get(runId), duplicateRisk: true };
  } finally {
    if (!transferred) {
      continuation?.release();
    }
  }
}

export async function dismissSubagentCompletionDelivery(
  runId: string,
  options: {
    discardTerminalDelivery: typeof SubagentLifecycleController.discardTerminalDelivery;
    databaseOptions?: OpenClawStateDatabaseOptions;
  },
): Promise<CompletionDeliveryRecoveryResult> {
  const current = subagentRuns.get(runId);
  if (!current || current.delivery?.status !== "suspended") {
    return { ok: false, reason: "completion delivery is not blocked" };
  }
  const now = Date.now();
  const subagent = structuredClone(current);
  settleSubagentCompletionDelivery({
    subagent,
    databaseOptions: options.databaseOptions,
    mutateSubagent: (entry) => options.discardTerminalDelivery(entry, now),
  });
  publishCommittedRecords(subagent);
  if (subagent.cleanup === "delete" || !subagent.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(subagent);
  }
  return { ok: true, run: subagentRuns.get(runId) };
}
