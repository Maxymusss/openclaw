import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  AgentDatabaseDeletionSnapshot,
  AgentDeletionJournalDisposition,
  AgentDeletionJournalStatus,
} from "./agent-deletion-journal.types.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateReadCommand } from "./openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

type AgentDeletionReadCommand = Extract<
  OpenClawStateReadCommand,
  { type: "agentDatabaseDeletion.snapshot" | "agentDeletionJournal.status" }
>;

/** Completed cleanup still retains a deletion tombstone. */
export function readAgentDeletionJournalStatusInDatabase(
  database: DatabaseSync,
  agentId: string,
): AgentDeletionJournalStatus {
  if (!tableExists(database, "agent_deletion_journal")) {
    return "absent";
  }
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database)
      .selectFrom("agent_deletion_journal")
      .select("cleanup_completed")
      .where("agent_id", "=", normalizeAgentId(agentId)),
  );
  return row ? (row.cleanup_completed === 1 ? "complete" : "pending") : "absent";
}

export async function readAgentDeletionJournalStatusInWorker(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
  signal?: AbortSignal,
): Promise<AgentDeletionJournalStatus> {
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "agentDeletionJournal.status", agentId: normalizeAgentId(agentId) },
    { current: true, signal },
  );
  if (reply && (!reply.ok || reply.type !== "agentDeletionJournal.status")) {
    throw new Error("Unexpected agent deletion journal read result");
  }
  return reply?.status ?? "absent";
}

export function parseAgentDeletionDatabasePaths(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    Array.isArray(parsed) &&
    parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    return parsed;
  }
  throw new Error("Invalid agent deletion database path journal.");
}

/** Read existing deletion history without initializing or repairing the journal. */
export function readRetainedAgentDeletionsFromDatabase(
  database: DatabaseSync,
): AgentDeletionJournalDisposition {
  if (!tableExists(database, "agent_deletion_journal")) {
    return "unavailable";
  }
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database)
      .selectFrom("agent_deletion_journal")
      .select(["agent_id", "agent_dir", "database_paths_json"])
      .where("cleanup_completed", "=", 1)
      .where("delete_files", "=", 0)
      .orderBy("agent_id", "asc"),
  ).rows.map((row) => ({
    agentId: row.agent_id,
    agentDir: row.agent_dir,
    databasePaths: [
      path.join(row.agent_dir, "openclaw-agent.sqlite"),
      ...parseAgentDeletionDatabasePaths(row.database_paths_json),
    ],
  }));
}

/** Read journal and registered-owner facts from one shared-state generation. */
export function readAgentDatabaseDeletionSnapshotInDatabase(
  database: DatabaseSync,
  statePath: string,
): AgentDatabaseDeletionSnapshot {
  return runSqliteDeferredTransactionSync(database, () => ({
    retainedDeletions: readRetainedAgentDeletionsFromDatabase(database),
    registeredAgentDatabases: readRegisteredAgentDatabaseRows(database, statePath, false),
  }));
}

export function executeAgentDeletionRead(
  database: DatabaseSync,
  statePath: string,
  command: AgentDeletionReadCommand,
) {
  const common = { ok: true as const };
  if (command.type === "agentDatabaseDeletion.snapshot") {
    return {
      ...common,
      type: command.type,
      snapshot: readAgentDatabaseDeletionSnapshotInDatabase(database, statePath),
    };
  }
  return {
    ...common,
    type: command.type,
    status: readAgentDeletionJournalStatusInDatabase(database, command.agentId),
  };
}

export function readAgentDatabaseDeletionSnapshot(env: NodeJS.ProcessEnv) {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db, path: statePath }) => readAgentDatabaseDeletionSnapshotInDatabase(db, statePath),
    { env },
  );
}

/** Repeated discovery reads keep their original source custody and observe current committed facts. */
export function prepareAgentDatabaseDeletionSnapshotRead(
  inputOptions: OpenClawStateDatabaseOptions = {},
): {
  read(): Promise<{
    snapshot: AgentDatabaseDeletionSnapshot | undefined;
    assertCurrent: () => void;
  }>;
} {
  const env = cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = {
    env,
    path: path.resolve(inputOptions.path ?? resolveOpenClawStateSqlitePath(env)),
  };
  const context = captureOpenClawStateWorkerContext(options);
  const assertCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  return {
    async read() {
      assertCurrent();
      const reply = await executeExistingOpenClawStateRead(
        options,
        { type: "agentDatabaseDeletion.snapshot" },
        { context, current: true },
      );
      assertCurrent();
      if (reply && (!reply.ok || reply.type !== "agentDatabaseDeletion.snapshot")) {
        throw new Error("Unexpected agent database deletion snapshot result");
      }
      return { snapshot: reply?.snapshot, assertCurrent };
    },
  };
}
