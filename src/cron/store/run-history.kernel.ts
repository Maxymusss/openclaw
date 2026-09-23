import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  cronRunRecordStoreKey,
  cronRunRecordToRunLogEntry,
  resolveCronRunRecordTimestamp,
} from "../run-history-detail.js";
import type { CronJsonValue, CronRunHistoryWrite, CronRunRecord } from "./run-history.types.js";

const query = (db: DatabaseSync) =>
  getNodeSqliteKysely<Pick<DB, "task_runs" | "task_delivery_state">>(db);
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOST_RETENTION_MS = 24 * 60 * 60_000;
export const CRON_HISTORY_KEEP_PER_JOB = 2000;

/** Released cron history lives in task_runs. Read only cron columns, without restoring Tasks. */
export function readCronRunRecordsInDatabase(db: DatabaseSync, jobId?: string): CronRunRecord[] {
  if (!tableExists(db, "task_runs")) {
    return [];
  }
  let select = query(db)
    .selectFrom("task_runs")
    .select([
      "task_id",
      "source_id",
      "run_id",
      "agent_id",
      "child_session_key",
      "created_at",
      "started_at",
      "ended_at",
      "last_event_at",
      "cleanup_after",
      "status",
      "error",
      "terminal_summary",
      "detail_json",
    ])
    .where("runtime", "=", "cron");
  if (jobId !== undefined) {
    select = select.where("source_id", "=", jobId);
  }
  return executeSqliteQuerySync(db, select).rows.flatMap((row) =>
    row.source_id
      ? [
          {
            id: row.task_id,
            jobId: row.source_id,
            runId: row.run_id ?? undefined,
            agentId: row.agent_id ?? undefined,
            sessionKey: row.child_session_key ?? undefined,
            createdAt: row.created_at,
            startedAt: row.started_at ?? undefined,
            endedAt: row.ended_at ?? undefined,
            lastEventAt: row.last_event_at ?? undefined,
            cleanupAfter: row.cleanup_after ?? undefined,
            status: row.status,
            error: row.error ?? undefined,
            summary: row.terminal_summary ?? undefined,
            detail:
              row.detail_json === null
                ? undefined
                : (safeParseJson(row.detail_json) as CronJsonValue | undefined),
          },
        ]
      : [],
  );
}

/** Caller owns the exact transaction. History never authorizes execution or receipt adoption. */
export function recordCronRunInDatabase(db: DatabaseSync, input: CronRunHistoryWrite): void {
  const existing = readCronRunRecordsInDatabase(db, input.jobId).find(
    (row) =>
      row.runId === input.runId &&
      (cronRunRecordStoreKey(row) === input.storeKey ||
        (row.detail === undefined && row.runId === `cron:${input.jobId}:${input.startedAt}`)),
  );
  // Late incompatible outcomes cannot replace a terminal result. The same outcome may
  // gain its public manual-run ID and post-commit delivery facts on the final event.
  if (
    existing?.endedAt !== undefined &&
    existing.status !== "lost" &&
    existing.status !== "cancelled" &&
    existing.status !== input.status &&
    cronRunRecordToRunLogEntry(existing)
  ) {
    return;
  }
  const terminal = {
    child_session_key: input.sessionKey ?? null,
    status: existing?.status === "cancelled" ? "cancelled" : input.status,
    ended_at: input.endedAt,
    last_event_at: input.endedAt,
    cleanup_after: input.endedAt + RETENTION_MS,
    error: existing?.status === "cancelled" ? (existing.error ?? null) : (input.error ?? null),
    terminal_summary: input.summary ?? existing?.summary ?? null,
    detail_json: JSON.stringify(input.detail),
  };
  if (existing) {
    executeSqliteQuerySync(
      db,
      query(db)
        .updateTable("task_runs")
        .set(terminal)
        .where("task_id", "=", existing.id)
        .where("runtime", "=", "cron"),
    );
  } else {
    // Required legacy columns retain their released encoding so rollback can still read these rows.
    executeSqliteQuerySync(
      db,
      query(db)
        .insertInto("task_runs")
        .values({
          task_id: randomUUID(),
          runtime: "cron",
          task_kind: "automation_run",
          source_id: input.jobId,
          requester_session_key: "",
          owner_key: "",
          scope_kind: "system",
          task: input.jobId,
          agent_id: input.agentId ?? null,
          run_id: input.runId,
          delivery_status: "not_applicable",
          notify_policy: "silent",
          created_at: input.startedAt,
          started_at: input.startedAt,
          ...terminal,
        }),
    );
  }
}

/** Same seven-day/lost-day and separate history/quiet-count bounds as released cron rows. */
export function collectExpiredCronRunIds(
  records: readonly CronRunRecord[],
  now: number,
): Set<string> {
  const expired = new Set<string>();
  const partitions = new Map<string, CronRunRecord[]>();
  for (const row of records) {
    if (row.status === "queued" || row.status === "running") {
      continue;
    }
    const timestamp = resolveCronRunRecordTimestamp(row);
    const defaultExpiry = timestamp + (row.status === "lost" ? LOST_RETENTION_MS : RETENTION_MS);
    const expiry =
      row.cleanupAfter === undefined
        ? defaultExpiry
        : row.status === "lost"
          ? Math.min(row.cleanupAfter, defaultExpiry)
          : row.cleanupAfter;
    if (now >= expiry) {
      expired.add(row.id);
    }
    if (row.status === "lost") {
      continue;
    }
    const key = JSON.stringify([
      cronRunRecordStoreKey(row),
      row.jobId,
      isRecord(row.detail) && row.detail.kind === "cron-run",
    ]);
    const partition = partitions.get(key) ?? [];
    partition.push(row);
    partitions.set(key, partition);
  }
  for (const rows of partitions.values()) {
    rows.sort(
      (a, b) =>
        resolveCronRunRecordTimestamp(b) - resolveCronRunRecordTimestamp(a) ||
        b.createdAt - a.createdAt ||
        b.id.localeCompare(a.id),
    );
    for (const row of rows.slice(CRON_HISTORY_KEEP_PER_JOB)) {
      expired.add(row.id);
    }
  }
  return expired;
}

export function pruneCronRunHistoryInDatabase(db: DatabaseSync, now: number): number {
  const ids = [...collectExpiredCronRunIds(readCronRunRecordsInDatabase(db), now)];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    if (tableExists(db, "task_delivery_state")) {
      executeSqliteQuerySync(
        db,
        query(db).deleteFrom("task_delivery_state").where("task_id", "in", batch),
      );
    }
    executeSqliteQuerySync(
      db,
      query(db).deleteFrom("task_runs").where("runtime", "=", "cron").where("task_id", "in", batch),
    );
  }
  return ids.length;
}
