import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import {
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../shared/transcript-only-openclaw-assistant.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import { buildRestartRecoveryClaimCleanupPatch } from "./restart-recovery-state.js";
import type {
  SessionAccessScope,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import {
  captureForegroundRecoveryExpectation,
  foregroundRunStoppedNoticeKey,
  readSessionForegroundRun,
  type SessionForegroundRun,
  type SessionForegroundRecoveryExpectation,
} from "./session-foreground-run.js";
import { mergeSessionEntry, type InternalSessionEntry } from "./types.js";

type ForegroundWrite = {
  scope: SessionAccessScope;
  admission: SessionForegroundRun;
  expectedWriterRunId: string | null;
  expectedRecovery: SessionForegroundRecoveryExpectation;
  gatewayLifecycleGeneration: string;
};

export type ForegroundWriteResult = {
  changed: boolean;
  notice?: TranscriptMessageAppendResult<unknown>;
};

export type SessionForegroundWorkerOperations = {
  admit: { input: ForegroundWrite; output: ForegroundWriteResult };
  stop: { input: ForegroundWrite; output: ForegroundWriteResult };
};

/** Negative recovery state and its notice share the canonical agent executor transaction. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<SessionForegroundWorkerOperations> {
  const db = context.database;
  return {
    execute(command) {
      const { admission, expectedWriterRunId } = command.input;
      const resolved = resolveSqliteTranscriptScope({
        ...command.input.scope,
        sessionId: admission.sessionId,
      });
      const database = getOpenClawAgentDatabaseIfOpen(toDatabaseOptions(resolved));
      if (!database || database.db !== db || database.path !== context.databasePath) {
        throw new Error("Foreground lifecycle lost its physical session store");
      }
      return withSqlitePostCommitPublications(db, () =>
        runSqliteImmediateTransactionSync(
          db,
          () => {
            context.admit("transaction");
            const selected = readSessionEntryRow(database, resolved.sessionKey);
            const entry = selected?.entry;
            if (
              !entry ||
              entry.sessionId !== admission.sessionId ||
              (entry.lifecycleRevision ?? null) !== admission.lifecycleRevision ||
              (entry.activeWriterRunId ?? null) !== expectedWriterRunId ||
              !isDeepStrictEqual(
                captureForegroundRecoveryExpectation(entry),
                command.input.expectedRecovery,
              )
            ) {
              return { changed: false };
            }
            const prior = readSessionForegroundRun(entry);
            if (command.type === "admit") {
              if (
                admission.deadlineAt <= Date.now() ||
                prior.kind === "invalid" ||
                entry.status === "running" ||
                (prior.kind === "bound" && prior.admission.runId === admission.runId)
              ) {
                throw new Error(
                  "Foreground admission changed; refresh the thread before sending again",
                );
              }
              const admissionPatch: Partial<InternalSessionEntry> = {
                foregroundRun: admission,
                status: "running",
                abortedLastRun: true,
                lifecycleRunId: admission.runId,
                startedAt: Date.now(),
                endedAt: undefined,
                updatedAt: Date.now(),
              };
              writeSessionEntry(
                database,
                resolved.sessionKey,
                mergeSessionEntry(entry, admissionPatch),
                { canonicalPreviousEntry: entry },
              );
              return { changed: true };
            }
            if (
              prior.kind !== "bound" ||
              !isDeepStrictEqual(prior.admission, admission) ||
              entry.status !== "running" ||
              (entry.activeWriterRunId !== undefined &&
                entry.activeWriterRunId !== admission.runId) ||
              (entry.lifecycleRunId !== undefined && entry.lifecycleRunId !== admission.runId) ||
              (entry.restartRecoveryDeliveryRunId !== undefined &&
                entry.restartRecoveryDeliveryRunId !== admission.runId)
            ) {
              return { changed: false };
            }
            // Durable foreground custody precedes runtime registration. Never clear
            // a current process's claim merely because its run is not visible yet.
            if (
              entry.mainRestartRecovery?.foregroundClaims?.lifecycleGeneration ===
                command.input.gatewayLifecycleGeneration &&
              entry.mainRestartRecovery.foregroundClaims.tokens.length > 0
            ) {
              return { changed: false };
            }
            const now = Date.now();
            const notice = appendTranscriptMessageInTransaction(database, resolved, {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text:
                      admission.gatewayLifecycleGeneration !==
                      command.input.gatewayLifecycleGeneration
                        ? "The Gateway restarted. This turn was not resumed automatically for security reasons. Your conversation history is preserved. Send a new request to continue."
                        : "This turn was interrupted and was not resumed for security reasons. Your conversation is saved. Send a new message to continue.",
                  },
                ],
                api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
                provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
                model: "gateway-injected",
                stopReason: "stop",
                timestamp: now,
                idempotencyKey: foregroundRunStoppedNoticeKey(admission),
                __openclaw: {
                  runId: admission.runId,
                  foregroundStopped: {
                    sessionId: admission.sessionId,
                    lifecycleRevision: admission.lifecycleRevision,
                  },
                },
              },
            });
            if (!notice) {
              throw new Error("Foreground stop notice was not persisted");
            }
            // Keep the accepted input for inspection, but revoke the exact custody
            // which otherwise makes Control UI reconnect automatically retry it.
            if (hasSessionPendingInputsSchema(db)) {
              executeSqliteQuerySync(
                db,
                getSessionKysely(db)
                  .updateTable("session_pending_inputs")
                  .set({ state: "cancelled" })
                  .where("session_key", "=", resolved.sessionKey)
                  .where("session_id", "=", admission.sessionId)
                  .where("run_id", "=", admission.runId)
                  .where("state", "in", ["queued", "interrupted"])
                  .where("consumed_event_id", "is", null),
              );
            }
            const appended = readSessionEntryRow(database, resolved.sessionKey)?.entry;
            if (!appended) {
              throw new Error("Foreground session disappeared while writing its notice");
            }
            const stopPatch: Partial<InternalSessionEntry> = {
              ...buildRestartRecoveryClaimCleanupPatch({
                entry: appended,
                recordTerminalSource: true,
                terminalRunId: admission.runId,
                terminalSourceRunId: admission.runId,
              }),
              abortedLastRun: false,
              activeWriterRunId: undefined,
              lifecycleRunId: undefined,
              lastRunId: admission.runId,
              mainRestartRecovery: undefined,
              restartRecoveryRuns: undefined,
              status: "interrupted",
              endedAt: now,
              updatedAt: now,
            };
            writeSessionEntry(
              database,
              resolved.sessionKey,
              mergeSessionEntry(appended, stopPatch),
              { canonicalPreviousEntry: appended },
            );
            return { changed: true, notice };
          },
          {
            operationLabel: `session.foreground.${command.type}`,
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: context.databasePath,
            withCommit(commit) {
              context.admit("commit");
              commit();
            },
          },
        ),
      );
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Foreground lifecycle transaction did not settle");
      }
    },
    close() {},
  };
}
