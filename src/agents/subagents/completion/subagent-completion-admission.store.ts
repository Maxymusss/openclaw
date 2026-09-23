import {
  bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "../../../infra/delivery-queue-sqlite-bound.js";
import {
  getDeliveryQueueEntryOwnersInDatabase,
  type DeliveryQueueStoredStatus,
} from "../../../infra/delivery-queue-sqlite.kernel.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import {
  prepareClaimedSessionDelivery,
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "../../../infra/session-delivery-queue.records.js";
import { deferSqlitePostCommitPublication } from "../../../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveEventSessionKey } from "../../../routing/session-key.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  isCompletedRequesterDeliveryBlocked,
} from "../registry/subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../registry/subagent-lifecycle-events.js";
import {
  clearSubagentPendingDelivery,
  loadPendingFinalDeliveryPayload,
  markRequesterSettleWakePending,
} from "../registry/subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { publishSubagentRunsAfterAtomicStore } from "../registry/subagent-registry-state.js";
import { bindSubagentRunRecord } from "../registry/subagent-registry.store.codec.js";
import {
  deleteSubagentRunRowInDatabase,
  upsertSubagentRunRowInDatabase,
} from "../registry/subagent-registry.store.kernel.js";
import {
  loadSubagentRunsForChildSessionFromSqlite,
  readSubagentRun,
} from "../registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { compareSubagentRunGeneration } from "../registry/subagent-run-generation.js";

const log = createSubsystemLogger("subagents/completion");

export const SUSPENDED_RETENTION_MS = 7 * 24 * 60 * 60_000;

type AdmissionTestHooks = {
  afterBind?: () => unknown;
  afterMutation?: (phase: "queue" | "subagent", database: OpenClawStateDatabase) => unknown;
};

function invokeSynchronousHook(hook: (() => unknown) | undefined): void {
  const result = hook?.();
  if (result && typeof (result as PromiseLike<unknown>).then === "function") {
    throw new Error("subagent completion admission transaction hooks must be synchronous");
  }
}

function replaceCommittedSubagent(subagent: SubagentRunRecord): void {
  const live = subagentRuns.get(subagent.runId);
  if (live) {
    for (const key of Object.keys(live)) {
      Reflect.deleteProperty(live, key);
    }
    Object.assign(live, subagent);
  } else {
    subagentRuns.set(subagent.runId, subagent);
  }
}

function publishCommittedSubagent(
  subagent: SubagentRunRecord,
  deferredObserverEvents: Array<() => void> = [],
): Array<() => void> {
  replaceCommittedSubagent(subagent);
  publishSubagentRunsAfterAtomicStore(subagentRuns, [subagent.runId], deferredObserverEvents);
  return deferredObserverEvents;
}

export function publishCommittedRecords(subagent: SubagentRunRecord): void {
  const deferredObserverEvents: Array<() => void> = [];
  publishCommittedSubagent(subagent, deferredObserverEvents);
  for (const emitObserverEvent of deferredObserverEvents) {
    emitObserverEvent();
  }
}

function assertCorrelatedEntry(params: {
  queueEntry: QueuedSessionDelivery;
  subagent: SubagentRunRecord;
}): void {
  const owner = params.queueEntry.kind === "agentTurn" ? params.queueEntry.owner : undefined;
  const delivery = params.subagent.delivery;
  if (
    !owner ||
    owner.kind !== "subagent_completion" ||
    owner.runId !== params.subagent.runId ||
    owner.generation !== delivery?.generation ||
    owner.deadlineAt !== delivery.deadlineAt ||
    params.queueEntry.id !== delivery.queueId
  ) {
    throw new Error("subagent completion admission records do not share one owner generation");
  }
}

/**
 * Commits the physical queue generation, logical completion owner, and task
 * projection as one database-only transaction on one exact shared-state handle.
 */
export function admitSubagentCompletionDelivery(params: {
  queueEntry: QueuedSessionDelivery;
  subagent: SubagentRunRecord;
  databaseOptions?: OpenClawStateDatabaseOptions;
  /** Transaction cut points used by the real-store crash-consistency tests. */
  testHooks?: AdmissionTestHooks;
}): { claimed: boolean; status: DeliveryQueueStoredStatus } {
  assertCorrelatedEntry(params);
  const boundQueue = bindDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry: params.queueEntry,
    insertOnly: true,
  });
  const boundSubagent = bindSubagentRunRecord(params.subagent);
  invokeSynchronousHook(params.testHooks?.afterBind);

  return runOpenClawStateWriteTransaction(
    (database) => {
      const claimed = upsertBoundDeliveryQueueEntryInDatabase(boundQueue, database);
      invokeSynchronousHook(() => params.testHooks?.afterMutation?.("queue", database));
      if (!claimed) {
        const existing = loadDeliveryQueueEntryInDatabase(
          database,
          SESSION_DELIVERY_QUEUE_NAME,
          params.queueEntry.id,
        ) as QueuedSessionDelivery | null;
        const expectedOwner =
          params.queueEntry.kind === "agentTurn" ? params.queueEntry.owner : undefined;
        const existingOwner = existing?.kind === "agentTurn" ? existing.owner : undefined;
        if (
          !existingOwner ||
          !expectedOwner ||
          existingOwner.kind !== expectedOwner.kind ||
          existingOwner.runId !== expectedOwner.runId ||
          existingOwner.taskId !== expectedOwner.taskId ||
          existingOwner.generation !== expectedOwner.generation ||
          existingOwner.deadlineAt !== expectedOwner.deadlineAt
        ) {
          throw new Error(`session delivery queue conflict for ${params.queueEntry.id}`);
        }
      }
      upsertSubagentRunRowInDatabase(database, boundSubagent);
      invokeSynchronousHook(() => params.testHooks?.afterMutation?.("subagent", database));
      const status =
        getDeliveryQueueEntryOwnersInDatabase(
          database,
          [SESSION_DELIVERY_QUEUE_NAME],
          params.queueEntry.id,
        ).get(SESSION_DELIVERY_QUEUE_NAME)?.status ?? "pending";
      return { claimed, status };
    },
    params.databaseOptions,
    { operationLabel: "subagent completion delivery admission" },
  );
}

/** Atomically consumes a correlated queue settlement into registry and task projections. */
export function settleSubagentCompletionDelivery(params: {
  subagent: SubagentRunRecord;
  databaseOptions?: OpenClawStateDatabaseOptions;
  mutateSubagent?: (entry: SubagentRunRecord) => unknown;
}): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      invokeSynchronousHook(() => params.mutateSubagent?.(params.subagent));
      upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(params.subagent));
    },
    params.databaseOptions,
    { operationLabel: "subagent completion delivery settlement" },
  );
}

function retiredCancellationEndedAt(subagent: SubagentRunRecord, now: number): number | undefined {
  const endedAt = subagent.execution.endedAt;
  if (
    subagent.execution.status !== "terminal" ||
    subagent.execution.outcome?.status !== "error" ||
    subagent.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
    typeof endedAt !== "number" ||
    !Number.isFinite(endedAt) ||
    typeof subagent.cleanupCompletedAt !== "number" ||
    !Number.isFinite(subagent.cleanupCompletedAt) ||
    subagent.cleanupCompletedAt < endedAt ||
    subagent.pauseReason ||
    subagent.killIntent ||
    subagent.terminalOwner ||
    subagent.execution.restartRecovery ||
    subagent.suppressAnnounceReason === "steer-restart" ||
    subagent.expectsCompletionMessage !== true ||
    subagent.completion?.required !== true ||
    !subagent.requesterSettleWake ||
    subagent.delivery?.status !== "pending" ||
    subagent.delivery.queueId ||
    endedAt + SUSPENDED_RETENTION_MS > now
  ) {
    return undefined;
  }
  return endedAt;
}

function ownsRetiredCancellation(
  database: OpenClawStateDatabase,
  subagent: SubagentRunRecord,
  expected: SubagentRunRecord,
): boolean {
  const newerSibling = (candidate: SubagentRunRecord) =>
    candidate.childSessionKey === subagent.childSessionKey &&
    compareSubagentRunGeneration(candidate, subagent) > 0;
  return (
    subagentRuns.get(subagent.runId) === expected &&
    bindSubagentRunRecord(subagent).payload_json === bindSubagentRunRecord(expected).payload_json &&
    ![...subagentRuns.values()].some(newerSibling) &&
    !loadSubagentRunsForChildSessionFromSqlite(subagent.childSessionKey, database).some(
      newerSibling,
    )
  );
}

/** A changed historical owner stays deferred instead of falling through to repeat cleanup. */
export function reconcileRetiredSubagentCancellation(
  expected: SubagentRunRecord,
  now: number,
): boolean | undefined {
  const endedAt = retiredCancellationEndedAt(expected, now);
  const marker = expected.killReconciliation;
  if (
    endedAt === undefined ||
    !marker ||
    !Number.isFinite(marker.killedAt) ||
    marker.killedAt > endedAt
  ) {
    return undefined;
  }
  return runOpenClawStateWriteTransaction((database) => {
    const subagent = readSubagentRun(database, expected.runId);
    if (!subagent || retiredCancellationEndedAt(subagent, now) !== endedAt) {
      return false;
    }
    if (!ownsRetiredCancellation(database, subagent, expected)) {
      return false;
    }
    subagent.killReconciliation = undefined;
    upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(subagent));
    deferSqlitePostCommitPublication(database.db, () => {
      publishCommittedSubagent(subagent).forEach((emit) => emit());
    });
    return true;
  });
}

type BlockSubagentCompletionParams = {
  subagent: SubagentRunRecord;
  reason: string;
  enqueuedAt?: number;
  suspendedReason?: "expiry" | "permanent_failure";
  storeReplaced?: true;
  lastDropReason?: NonNullable<SubagentRunRecord["delivery"]>["lastDropReason"];
  disposition?: NonNullable<SubagentRunRecord["delivery"]>["disposition"];
  databaseOptions?: OpenClawStateDatabaseOptions;
};

type CompletionMutation = {
  subagent: SubagentRunRecord;
  queued?: QueuedSessionDelivery;
  retire?: boolean;
};

// One mutation kernel serves ordinary blocking and whole requester-batch settlement.
// It only prepares records; its caller owns the transaction and final publication.
function prepareBlockedSubagentCompletion(
  database: OpenClawStateDatabase,
  params: BlockSubagentCompletionParams,
  now: number,
  subagent: SubagentRunRecord | null,
): CompletionMutation | undefined {
  const generation = params.subagent.delivery?.generation ?? 1;
  if (
    !subagent ||
    subagent.execution.status !== "terminal" ||
    !subagent.execution.outcome ||
    subagent.pauseReason === "sessions_yield" ||
    subagent.expectsCompletionMessage !== true ||
    (subagent.delivery?.generation ?? 1) !== generation ||
    subagentRuns.get(subagent.runId) !== params.subagent ||
    bindSubagentRunRecord(subagent).payload_json !==
      bindSubagentRunRecord(params.subagent).payload_json
  ) {
    return undefined;
  }
  const successful = subagent.execution.outcome?.status === "ok";
  if (
    !successful &&
    ((params.suspendedReason !== undefined && !params.storeReplaced) ||
      !["pending", "in_progress", "failed"].includes(subagent.delivery?.status ?? "pending"))
  ) {
    return undefined;
  }
  // Historical cancelled wakes retain their exact native owner. Capture their
  // intentional empty result only after kill reconciliation has committed.
  const retiredEndedAt = retiredCancellationEndedAt(subagent, now);
  if (retiredEndedAt !== undefined) {
    if (
      subagent.killReconciliation ||
      !ownsRetiredCancellation(database, subagent, params.subagent)
    ) {
      return undefined;
    }
    const completion = ensureCompletionState(subagent);
    completion.resultText ??= null;
    completion.capturedAt ??= retiredEndedAt;
  }
  const delivery = ensureDeliveryState(subagent);
  if (
    params.storeReplaced &&
    (delivery.status === "delivered" ||
      delivery.announcedAt !== undefined ||
      delivery.deliveredAt !== undefined)
  ) {
    return undefined;
  }
  delivery.payload ??= loadPendingFinalDeliveryPayload(subagent);
  if (typeof params.enqueuedAt === "number") {
    delivery.enqueuedAt ??= params.enqueuedAt;
  }
  Object.assign(delivery, {
    status: params.suspendedReason ? ("suspended" as const) : ("failed" as const),
    disposition: params.storeReplaced
      ? ("intentional_non_delivery" as const)
      : params.suspendedReason
        ? ("permanent_failure" as const)
        : (params.disposition ?? delivery.disposition),
    lastError: params.reason,
    deliveredAt: undefined,
    announcedAt: undefined,
    suspendedAt: params.suspendedReason ? (delivery.suspendedAt ?? now) : delivery.suspendedAt,
    suspendedReason: params.suspendedReason ?? delivery.suspendedReason,
    lastDropReason: params.lastDropReason ?? delivery.lastDropReason,
    nextAttemptAt: undefined,
    queueId: undefined,
  });
  Object.assign(subagent, { cleanupHandled: false, wakeOnDescendantSettle: undefined });
  if (params.storeReplaced) {
    subagent.requesterSettleWake = undefined;
  } else if (params.suspendedReason) {
    if (isCompletedRequesterDeliveryBlocked(subagent)) {
      // This requester already ran. An ordinary settle wake would replay it;
      // a separately owned yield batch still has genuine unfinished work.
      if (subagent.requesterSettleWake?.requesterYieldBatch !== true) {
        subagent.requesterSettleWake = undefined;
      }
    } else {
      markRequesterSettleWakePending(subagent);
    }
  } else {
    subagent.suppressCompletionDelivery = true;
  }
  const text =
    successful && !params.storeReplaced
      ? "Subagent completion delivery is blocked: " + params.reason
      : null;
  const queued = text
    ? prepareClaimedSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: resolveEventSessionKey(subagent.requesterSessionKey),
          ...(subagent.requesterAgentId ? { agentId: subagent.requesterAgentId } : {}),
          text,
          ...(subagent.requesterOrigin ? { deliveryContext: subagent.requesterOrigin } : {}),
          idempotencyKey: `subagent-completion-blocked:${subagent.runId}:generation:${generation}`,
        },
        0,
        now,
      )
    : undefined;
  return { subagent, queued };
}

function commitCompletionMutations(
  database: OpenClawStateDatabase,
  mutations: readonly CompletionMutation[],
  options?: OpenClawStateDatabaseOptions,
): void {
  for (const { subagent, queued, retire } of mutations) {
    if (queued) {
      upsertBoundDeliveryQueueEntryInDatabase(
        bindDeliveryQueueEntry({
          queueName: SESSION_DELIVERY_QUEUE_NAME,
          entry: queued,
          insertOnly: true,
        }),
        database,
      );
    }
    if (retire) {
      deleteSubagentRunRowInDatabase(database, subagent.runId);
    } else {
      upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(subagent));
    }
  }
  deferSqlitePostCommitPublication(database.db, () => {
    const events: Array<() => void> = [];
    for (const { subagent, retire } of mutations) {
      if (retire) {
        subagentRuns.delete(subagent.runId);
      } else {
        replaceCommittedSubagent(subagent);
      }
    }
    publishSubagentRunsAfterAtomicStore(
      subagentRuns,
      mutations.map(({ subagent }) => subagent.runId),
      events,
    );
    for (const emit of events) {
      emit();
    }
    for (const { queued } of mutations) {
      if (queued) {
        void (async () => {
          const queueContext = captureOpenClawStateWorkerContext({
            path: database.path,
            env: options?.env,
          });
          await scheduleSessionDelivery(queued.id, queueContext);
        })().catch((error: unknown) => {
          log.warn("Subagent completion remains queued after scheduling failed", {
            queueId: queued.id,
            error,
          });
        });
      }
    }
  });
}

export function blockSubagentCompletionDelivery(params: BlockSubagentCompletionParams): boolean {
  return runOpenClawStateWriteTransaction((database) => {
    const mutation = prepareBlockedSubagentCompletion(
      database,
      params,
      Date.now(),
      readSubagentRun(database, params.subagent.runId),
    );
    if (!mutation) {
      return false;
    }
    commitCompletionMutations(database, [mutation], params.databaseOptions);
    return true;
  }, params.databaseOptions);
}

/** Commits delivery, task, blocked alert, wake consumption, and retirement as one exact batch. */
export function settleRequesterCompletionBatch(params: {
  entries: readonly { subagent: SubagentRunRecord }[];
  outcome: SubagentAnnounceDeliveryResult;
  isCurrent(): boolean;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      if (!params.isCurrent()) {
        throw new Error("subagent completion owner changed before settlement");
      }
      const now = Date.now();
      const entries = params.entries;
      const ids = new Set(entries.map(({ subagent }) => subagent.runId));
      const first = entries[0]?.subagent;
      const cohort = first?.requesterSettleWake?.batchRunIds?.toSorted().join("\0");
      const checkedOmittedIds = new Set<string>();
      const mutations = entries.map(({ subagent: expected }): CompletionMutation => {
        const changedOwner = () =>
          new Error("subagent completion owner changed before settlement: " + expected.runId);
        const subagent = readSubagentRun(database, expected.runId);
        if (
          !subagent ||
          !subagent.requesterSettleWake ||
          subagent.requesterSessionKey !== first?.requesterSessionKey ||
          subagent.requesterAgentId !== first?.requesterAgentId ||
          subagent.requesterSettleWake.rearmGeneration !==
            first?.requesterSettleWake?.rearmGeneration ||
          subagent.requesterSettleWake.batchRunIds?.toSorted().join("\0") !== cohort ||
          subagentRuns.get(expected.runId) !== expected ||
          bindSubagentRunRecord(subagent).payload_json !==
            bindSubagentRunRecord(expected).payload_json
        ) {
          throw changedOwner();
        }
        // A caller may omit retired rows, never a surviving member of the same frozen wave.
        for (const id of subagent.requesterSettleWake?.batchRunIds ?? []) {
          if (!ids.has(id) && !checkedOmittedIds.has(id)) {
            const member = readSubagentRun(database, id);
            if (
              member?.requesterSettleWake &&
              member.requesterSettleWake.rearmGeneration ===
                subagent.requesterSettleWake?.rearmGeneration
            ) {
              throw changedOwner();
            }
            // Planning performs no writes, so this check holds for the remaining same-wave rows.
            checkedOmittedIds.add(id);
          }
        }
        // Decoding restores restart defaults, not the active process's cleanup ownership.
        subagent.cleanupHandled = expected.cleanupHandled;
        // An exact requester receipt can arrive after expiry transferred this result to its wake.
        const acknowledgeExpiredDelivery =
          params.outcome.delivered &&
          subagent.delivery?.status === "suspended" &&
          subagent.delivery.suspendedReason === "expiry";
        let mutation: CompletionMutation = { subagent };
        if (
          subagent.pauseReason !== "sessions_yield" &&
          subagent.expectsCompletionMessage === true &&
          (["pending", "in_progress"].includes(subagent.delivery?.status ?? "pending") ||
            acknowledgeExpiredDelivery)
        ) {
          if (params.outcome.delivered) {
            const delivery = ensureDeliveryState(subagent);
            const deliveredAt = params.outcome.deliveredAt ?? now;
            Object.assign(delivery, {
              status: "delivered",
              disposition: "delivered",
              deliveredAt,
              announcedAt: deliveredAt,
              lastDropReason: undefined,
            });
            clearSubagentPendingDelivery(subagent);
          } else {
            const blocked = prepareBlockedSubagentCompletion(
              database,
              {
                subagent: expected,
                reason:
                  params.outcome.error ?? params.outcome.reason ?? "requester settle wake failed",
                disposition: params.outcome.disposition,
                storeReplaced: params.outcome.storeReplaced,
                suspendedReason: params.outcome.storeReplaced ? "permanent_failure" : undefined,
              },
              now,
              subagent,
            );
            if (!blocked) {
              throw changedOwner();
            }
            mutation = blocked;
          }
        }
        const settled = mutation.subagent;
        if (settled.pauseReason !== "sessions_yield") {
          if (settled.requesterTurnRunId && settled.expectsCompletionMessage === true) {
            settled.retireAfterRequesterTurn =
              settled.retireAfterRequesterTurn === true ||
              settled.requesterSettleWake?.retireAfterSettle === true
                ? true
                : undefined;
          } else {
            mutation.retire = settled.requesterSettleWake?.retireAfterSettle === true;
          }
        }
        settled.requesterSettleWake = undefined;
        return mutation;
      });
      commitCompletionMutations(database, mutations, params.databaseOptions);
    },
    params.databaseOptions,
    { operationLabel: "requester completion batch settlement" },
  );
}
