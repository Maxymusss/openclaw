import type { DatabaseSync } from "node:sqlite";

/** Snapshot facts for one locked write; never retain them across transaction admission. */
export type CronRunReceiptWriteSchema = Readonly<{
  executionOwnerLifecycleBindings: boolean;
}>;

/** Capture optional storage once at the owning write transaction's admission. */
export function prepareCronRunReceiptWriteSchema(db: DatabaseSync): CronRunReceiptWriteSchema {
  if (!db.isTransaction) {
    throw new Error("Cron receipt schema admission requires the owning write transaction");
  }
  // No handle cache: another connection can allocate the opt-in table, and a
  // failed first binding can roll its DDL back. Each admission uses its own
  // locked snapshot; receipt kernels and pruning consume only the carried fact.
  // sqlite-allow-raw -- Feature write admission captures optional table presence, never runtime kernels.
  const row = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'execution_owner_lifecycle_bindings'",
    )
    .get();
  return { executionOwnerLifecycleBindings: row !== undefined };
}
