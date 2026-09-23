import type { DatabaseSync } from "node:sqlite";
import { PRE_V19_TASK_SCHEMA_SQL } from "./openclaw-state-schema-v19.test-support.js";

export function removePreparedWorkerOwnershipColumns(db: DatabaseSync): void {
  db.exec(PRE_V19_TASK_SCHEMA_SQL);
  // Drop the constrained column first so the fixture has the actual pre-v17
  // worker shape, rather than only an older version marker.
  for (const column of [
    "preparation_consumed_at_ms",
    "preparation_expires_at_ms",
    "preparation_demand_at_ms",
    "preparation_key",
    "last_activated_at_ms",
  ]) {
    db.exec(`ALTER TABLE worker_environments DROP COLUMN ${column};`);
  }
}
