import type { DatabaseSync } from "node:sqlite";
import { RETIRED_TASK_SCHEMA_SQL } from "./openclaw-state-db-schema-v19-task-source.js";

// Older-version fixtures need the historical owner tables, not merely a lower
// marker on a fresh v19 database. This is test input, never a runtime ensure.
export const PRE_V19_TASK_SCHEMA_SQL =
  RETIRED_TASK_SCHEMA_SQL + "DROP TABLE IF EXISTS cron_run_history;";

/** Reconstruct the frozen v18 Task contract before exercising an actual upgrade. */
export function restorePreV19StateSchemaForTest(database: DatabaseSync): void {
  database.exec(PRE_V19_TASK_SCHEMA_SQL);
  database.exec("PRAGMA user_version = 18;");
  database.prepare("UPDATE schema_meta SET schema_version = 18 WHERE meta_key = 'primary'").run();
  database
    .prepare("DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'")
    .run();
}
