import type {
  ExecutionOwnerBinding,
  ExecutionOwnerBindingResult,
} from "../../audit/execution-owner-binding.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { CronStoreWorkerOperations } from "./load-worker.types.js";
import { loadMutableCronStoreInWorker } from "./load.worker.js";
import { pruneCronRunHistoryInDatabase, recordCronRunInDatabase } from "./run-history.kernel.js";
import type { CronRunHistoryWorkerOperations } from "./run-history.types.js";
import {
  bindCronRunReceiptExecutionInDatabase,
  type CronRunReceiptHandle,
} from "./run-receipt-store.js";
import type { CronRunRecoveryWorkerOperations } from "./run-recovery.types.js";
import { proposeCronRunRecoveryInWorker } from "./run-recovery.worker.js";
import type { CronStoreSaveWorkerOperations } from "./save-worker.types.js";
import { executeCronStoreSaveCommand } from "./save.worker.js";

export type CronStateWorkerOperations = CronRunHistoryWorkerOperations &
  CronStoreWorkerOperations &
  CronRunRecoveryWorkerOperations &
  CronStoreSaveWorkerOperations & {
    "cron.bindReceiptExecution": {
      input: { handle: CronRunReceiptHandle; binding: ExecutionOwnerBinding };
      output: ExecutionOwnerBindingResult;
    };
  };

export function isCronStateWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<CronStateWorkerOperations> {
  switch (command.type) {
    case "cron.recordRun":
    case "cron.pruneHistory":
    case "cron.loadMutable":
    case "cron.proposeRunRecovery":
    case "cron.save":
    case "cron.saveChanges":
    case "cron.bindReceiptExecution":
      return true;
    default:
      return false;
  }
}

export function executeCronStateCommand(
  command: SqliteWorkerCommand<CronStateWorkerOperations>,
  database: OpenClawStateDatabase,
): CronStateWorkerOperations[keyof CronStateWorkerOperations]["output"] {
  switch (command.type) {
    case "cron.recordRun":
    case "cron.pruneHistory":
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          const result =
            command.type === "cron.recordRun"
              ? recordCronRunInDatabase(db, command.input)
              : pruneCronRunHistoryInDatabase(db, command.input.now);
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          return result;
        },
        { database, path: database.path, env: getSqliteWorkerStateContext().environment },
        { operationLabel: command.type },
      );
    case "cron.loadMutable":
      return loadMutableCronStoreInWorker(database, command.input.storeKey);
    case "cron.proposeRunRecovery":
      return proposeCronRunRecoveryInWorker(database, command.input);
    case "cron.save":
    case "cron.saveChanges":
      return executeCronStoreSaveCommand(command, database);
    case "cron.bindReceiptExecution":
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          const result = bindCronRunReceiptExecutionInDatabase(
            db,
            command.input.handle,
            command.input.binding,
          );
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          return result;
        },
        { database, path: database.path, env: getSqliteWorkerStateContext().environment },
        { operationLabel: "cron.run-receipt.execution-binding" },
      );
    default:
      throw new Error("Unknown Cron shared-state worker command");
  }
}
