import type { DatabaseSync } from "node:sqlite";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import {
  updateSessionProfileInvolvementInDatabase,
  type SessionInvolvementChange,
} from "./session-accessor.involvement-kernel.js";
import {
  readPendingInputAdmission,
  insertPendingInputAdmission,
  type PendingInputAdmissionRead,
  type PendingInputAdmissionInsert,
} from "./session-accessor.pending-input-admission.js";

export type SessionInputCustodyOperations = {
  inspect: {
    input: PendingInputAdmissionRead;
    output: ReturnType<typeof readPendingInputAdmission>;
  };
  accept: { input: PendingInputAdmissionInsert; output: boolean };
  mention: {
    input: { sessionKey: string; params: SessionInvolvementChange };
    output: ReturnType<typeof updateSessionProfileInvolvementInDatabase>;
  };
};

export function bindSqliteWorkerBackend(
  input: { agentId: string },
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<SessionInputCustodyOperations> {
  const database = getOpenClawAgentDatabaseIfOpen({
    agentId: input.agentId,
    path: context.databasePath,
  });
  if (!database || database.db !== context.database) {
    throw new Error("Pending input worker lost its canonical database");
  }
  return {
    execute(command) {
      return withSqlitePostCommitPublications(context.database, () =>
        runSqliteImmediateTransactionSync(
          context.database,
          () => {
            context.admit("transaction");
            if (command.type === "inspect") {
              return readPendingInputAdmission(database, command.input);
            }
            if (command.type === "accept") {
              return insertPendingInputAdmission(database, command.input);
            }
            return updateSessionProfileInvolvementInDatabase(
              database,
              command.input,
              command.input.params,
            );
          },
          {
            operationLabel: "session.input-custody",
            databaseLabel: context.databasePath,
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            withCommit(commit) {
              context.admit("commit");
              commit();
            },
          },
        ),
      );
    },
    assertSettled() {
      assertTransactionUsable(context.database);
      if (context.database.isTransaction) {
        throw new Error("Pending input worker transaction did not settle");
      }
    },
    close() {},
  };
}
