import type { DatabaseSync } from "node:sqlite";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import {
  repairLegacySubagentExecutionPayloads,
  repairLegacySubagentRetainedResults,
} from "./openclaw-state-db-legacy-backfills.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  assertLegacyTaskRetirementSource,
  assertNoRetainedTaskDependencies,
  RETIRED_TASK_TABLES,
} from "./openclaw-state-db-schema-v19-task-source.js";
import { migrateLegacyTaskSubagentOutcomes } from "./openclaw-state-db-schema-v19-task-subagent-outcomes.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

/** Called after v13 canonicalization, inside the existing fenced schema transaction. */
export function migrateTasksRetirementV19(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 19) {
    return false;
  }
  if (!db.isTransaction) {
    throw new Error("Tasks retirement requires the schema migration transaction.");
  }
  assertLegacyTaskRetirementSource(db, previousVersion);
  assertNoRetainedTaskDependencies(db);
  const historySchema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "cron_run_history", {
    endMarker: "ON cron_run_history(job_id);",
  });
  // Refuse a name collision or drift before IF NOT EXISTS could conceal it.
  assertSqliteSchemaContains(db, "Cron history migration target", historySchema, {
    allowedMissingTables: ["cron_run_history"],
  });
  db.exec(historySchema);
  if (tableExists(db, "task_runs")) {
    // Copy, do not decode/re-encode or normalize. Unknown/deleted job IDs and raw
    // JSON are retained; run_id was never unique. Conflicts abort the whole upgrade.
    const detail = tableHasColumn(db, "task_runs", "detail_json") ? "detail_json" : "NULL";
    db.exec(`INSERT INTO cron_run_history (
      history_id, job_id, run_id, agent_id, session_key, created_at, started_at,
      ended_at, last_event_at, cleanup_after, status, error, summary, detail_json
    ) SELECT task_id, source_id, run_id, agent_id, child_session_key, created_at, started_at,
      ended_at, last_event_at, cleanup_after, status, error, terminal_summary, ${detail}
      FROM task_runs WHERE runtime = 'cron';`);
  }
  repairLegacySubagentExecutionPayloads(db);
  repairLegacySubagentRetainedResults(db);
  migrateLegacyTaskSubagentOutcomes(db);
  if (tableExists(db, "execution_owner_lifecycle_bindings")) {
    // This opt-in table also owns retained Cron bindings. Validate before DELETE
    // so an unknown trigger or changed shape cannot expand retirement's scope.
    assertSqliteSchemaContains(
      db,
      "Task lifecycle binding retirement source",
      extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "execution_owner_lifecycle_bindings"),
    );
    // Only the released Task/flow owner kinds retire, including orphan bindings.
    // Shared context IDs do not authorize deleting independent audit evidence.
    db.exec("DELETE FROM execution_owner_lifecycle_bindings WHERE owner_kind IN ('task', 'flow');");
  }
  // Delivery is dropped before its parent; FK actions are disabled by the outer
  // owner. Dependency proof above prevents dropping unrelated dependent data.
  for (const table of RETIRED_TASK_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table};`);
  }
  return true;
}
