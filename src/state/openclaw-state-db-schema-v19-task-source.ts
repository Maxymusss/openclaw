import type { DatabaseSync } from "node:sqlite";
import {
  assertSqliteIntegrity,
  SqliteRepairableForeignKeyError,
} from "../infra/sqlite-integrity.js";
import {
  assertSqliteSchemaContains,
  collectSqliteNamedIndexContract,
  getCanonicalSqliteNamedIndexContracts,
} from "../infra/sqlite-schema-contract.js";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

// Frozen pre-v19 source contract. Never recreate these tables during current-schema open.
// The v2026.7.1-2 source has the same base columns without STRICT, later nullable
// projections, or newer indexes; the explicit compatibility below admits it.
// Shipped Tasks rows are consumed only by the schema-19 retirement migration.
export const RETIRED_TASK_TABLES = ["task_delivery_state", "task_runs", "flow_runs"] as const;

export const RETIRED_TASK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_runs (
  task_id TEXT NOT NULL PRIMARY KEY,
  runtime TEXT NOT NULL,
  task_kind TEXT,
  source_id TEXT,
  requester_session_key TEXT,
  owner_key TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  child_session_key TEXT,
  parent_flow_id TEXT,
  parent_task_id TEXT,
  agent_id TEXT,
  requester_agent_id TEXT,
  run_id TEXT,
  execution_owner_host TEXT,
  execution_owner_pid INTEGER,
  execution_owner_start_identity INTEGER,
  label TEXT,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  notify_policy TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  last_event_at INTEGER,
  cleanup_after INTEGER,
  tool_use_count INTEGER,
  last_tool_name TEXT,
  error TEXT,
  progress_summary TEXT,
  terminal_summary TEXT,
  terminal_outcome TEXT,
  detail_json TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_task_runs_run_id ON task_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_status ON task_runs(runtime, status);
CREATE INDEX IF NOT EXISTS idx_task_runs_cleanup_after ON task_runs(cleanup_after);
CREATE INDEX IF NOT EXISTS idx_task_runs_last_event_at ON task_runs(last_event_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_owner_key ON task_runs(owner_key);
CREATE INDEX IF NOT EXISTS idx_task_runs_parent_flow_id ON task_runs(parent_flow_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_child_session_key ON task_runs(child_session_key);
CREATE INDEX IF NOT EXISTS idx_task_runs_requester_session_key ON task_runs(requester_session_key);
CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_source_ended
  ON task_runs(runtime, source_id, ended_at, created_at, task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_ended
  ON task_runs(runtime, ended_at, created_at, task_id);

CREATE TABLE IF NOT EXISTS task_delivery_state (
  task_id TEXT NOT NULL PRIMARY KEY,
  requester_origin_json TEXT,
  last_notified_event_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES task_runs(task_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS flow_runs (
  flow_id TEXT NOT NULL PRIMARY KEY,
  shape TEXT,
  sync_mode TEXT NOT NULL DEFAULT 'managed',
  owner_key TEXT NOT NULL,
  requester_origin_json TEXT,
  controller_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  notify_policy TEXT NOT NULL,
  goal TEXT NOT NULL,
  current_step TEXT,
  blocked_task_id TEXT,
  blocked_summary TEXT,
  state_json TEXT,
  wait_json TEXT,
  cancel_requested_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_flow_runs_status ON flow_runs(status);
CREATE INDEX IF NOT EXISTS idx_flow_runs_owner_key ON flow_runs(owner_key);
CREATE INDEX IF NOT EXISTS idx_flow_runs_updated_at ON flow_runs(updated_at);

`;

// These nullable fields shipped as additive Task projections, and indexes were
// installed on writable opens. Their absence is not permission to invent data.
const OPTIONAL_TASK_COLUMNS = [
  "requester_agent_id",
  "execution_owner_host",
  "execution_owner_pid",
  "execution_owner_start_identity",
  "tool_use_count",
  "last_tool_name",
  "detail_json",
] as const;

/** The released source shape, not today's schema, authorizes destructive retirement. */
export function assertLegacyTaskRetirementSource(db: DatabaseSync, previousVersion: number): void {
  const schema =
    previousVersion < 3
      ? RETIRED_TASK_SCHEMA_SQL.replaceAll(") STRICT;", ");")
      : RETIRED_TASK_SCHEMA_SQL;
  const indexes = getCanonicalSqliteNamedIndexContracts(schema);
  assertSqliteSchemaContains(db, "legacy Tasks retirement source", schema, {
    allowedMissingTables: RETIRED_TASK_TABLES,
    allowedMissingColumns: OPTIONAL_TASK_COLUMNS.map((column) => "task_runs." + column),
    allowedMissingIndexes: indexes.map((index) => index.name),
  });
  const expectedIndexes = new Map(
    indexes.map((index) => [index.name, JSON.stringify(index.fingerprint)]),
  );
  for (const table of RETIRED_TASK_TABLES) {
    const objects = db
      .prepare(
        "SELECT type, name FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL",
      )
      .all(table);
    for (const object of objects) {
      if (
        object.type !== "index" ||
        typeof object.name !== "string" ||
        JSON.stringify(collectSqliteNamedIndexContract(db, object.name)) !==
          expectedIndexes.get(object.name)
      ) {
        throw new Error(
          "Unrecognized attached object on retired Tasks table " +
            table +
            "; refusing destructive migration.",
        );
      }
    }
  }
}

/** Only the shipped orphan relation can enter the fenced schema-19 retirement. */
export function assertStateIntegrityForSchemaMigration(
  db: DatabaseSync,
  pathname: string,
  previousVersion: number,
): void {
  try {
    assertSqliteIntegrity(db, pathname);
  } catch (error) {
    if (previousVersion >= 19 || !(error instanceof SqliteRepairableForeignKeyError)) {
      throw error;
    }
    // The integrity owner classifies only an exact single-column cascade and
    // checks every violation, including unrelated FKs beyond its display limit.
    assertLegacyTaskRetirementSource(db, previousVersion);
  }
}

/** SQLite resolves quoted identifiers and indirect references for the migration owner. */
export function assertNoRetainedTaskDependencies(db: DatabaseSync): void {
  const retired = new Set<string>(RETIRED_TASK_TABLES);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
  for (const row of tables) {
    if (typeof row.name !== "string" || retired.has(row.name.toLowerCase())) {
      continue;
    }
    const keys = db
      .prepare("PRAGMA foreign_key_list(" + quoteSqliteIdentifier(row.name) + ")")
      .all();
    if (keys.some((key) => typeof key.table === "string" && retired.has(key.table.toLowerCase()))) {
      throw new Error(
        "Retired Tasks tables are referenced by table " +
          row.name +
          "; refusing destructive migration.",
      );
    }
  }
  const retainedSql = () =>
    db
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE type IN ('view', 'trigger') AND sql IS NOT NULL ORDER BY type, name",
      )
      .all();
  const before = JSON.stringify(retainedSql());
  for (const table of RETIRED_TASK_TABLES) {
    if (!tableExists(db, table)) {
      continue;
    }
    const probe = "__openclaw_v19_" + table + "_probe";
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ? COLLATE NOCASE").get(probe)) {
      throw new Error("Task retirement probe object already exists: " + probe);
    }
    db.exec("SAVEPOINT openclaw_v19_task_dependencies;");
    try {
      db.exec("ALTER TABLE " + table + " RENAME TO " + quoteSqliteIdentifier(probe) + ";");
      if (JSON.stringify(retainedSql()) !== before) {
        throw new Error(
          "Retired Tasks table " + table + " is referenced by a retained view or trigger.",
        );
      }
    } finally {
      db.exec(
        "ROLLBACK TO openclaw_v19_task_dependencies; RELEASE openclaw_v19_task_dependencies;",
      );
    }
  }
}
