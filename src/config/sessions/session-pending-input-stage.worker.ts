import type { DatabaseSync } from "node:sqlite";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import type {
  PendingInputStageOperations,
  SessionPendingInputAuthorityFacts,
} from "./session-pending-input-stage.js";
import {
  inspectPendingInputStage,
  readPendingInputStageTranscript,
  commitPendingInputStage,
} from "./session-pending-input-stage.kernel.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";

export function bindSqliteWorkerBackend(
  input: { agentId: string },
  context: {
    database: DatabaseSync;
    databasePath: string;
    admit(stage: "transaction" | "commit", facts: SessionPendingInputAuthorityFacts): void;
  },
): SqliteWorkerBackend<PendingInputStageOperations> {
  const database = { db: context.database, path: context.databasePath, agentId: input.agentId };
  let closed = false;
  return {
    execute(command) {
      if (closed) throw new Error("Pending input publication scope is closed");
      const { scope } = command.input;
      if (
        (scope.databaseAgentId ?? scope.agentId) !== database.agentId ||
        scope.path !== database.path
      )
        throw new Error("Pending input operation changed its physical owner");
      const facts = (): SessionPendingInputAuthorityFacts => ({
        kind: "session.pending-input",
        agentId: scope.agentId,
        storePath: database.path,
        sessionKey: scope.sessionKey,
        entry: readSessionEntryRow(database, scope.sessionKey)?.entry,
        members: listSessionMembersInDatabase(database, scope.sessionKey),
      });
      return runSqliteImmediateTransactionSync(
        database.db,
        () => {
          context.admit("transaction", facts());
          return command.type === "pendingInput.inspect"
            ? inspectPendingInputStage(database, command.input)
            : command.type === "pendingInput.transcript"
              ? readPendingInputStageTranscript(database, command.input)
              : commitPendingInputStage(database, command.input);
        },
        {
          databaseLabel: database.path,
          operationLabel: command.type,
          withCommit(commit) {
            context.admit("commit", facts());
            commit();
          },
        },
      );
    },
    assertSettled() {
      assertTransactionUsable(database.db);
      if (database.db.isTransaction)
        throw new Error("Pending input publication left an unsettled transaction");
    },
    close() {
      closed = true;
    },
  };
}
