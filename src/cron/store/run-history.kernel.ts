import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  cronRunRecordStoreKey,
  cronRunRecordToRunLogEntry,
  parseCronRunDetailJson,
  resolveCronRunRecordTimestamp,
} from "../run-history-detail.js";
import type { CronRunHistoryWrite, CronRunRecord } from "./run-history.types.js";

const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, "cron_run_history">>(db);
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOST_RETENTION_MS = 24 * 60 * 60_000;
export const CRON_HISTORY_KEEP_PER_JOB = 2000;

/** Reads admitted cron history; legacy job identities and detail bytes remain unchanged. */
export function readCronRunRecordsInDatabase(db: DatabaseSync, jobId?: string): CronRunRecord[] {
  let select = query(db)
    .selectFrom("cron_run_history")
    .select([
      "history_id",
      "job_id",
      "run_id",
      "agent_id",
      "session_key",
      "created_at",
      "started_at",
      "ended_at",
      "last_event_at",
      "cleanup_after",
      "status",
      "error",
      "summary",
      "detail_json",
    ]);
  if (jobId !== undefined) {
    select = select.where("job_id", "=", jobId);
  }
  return executeSqliteQuerySync(db, select).rows.map((row) => ({
    id: row.history_id,
    jobId: row.job_id,
    runId: row.run_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    sessionKey: row.session_key ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    lastEventAt: row.last_event_at ?? undefined,
    cleanupAfter: row.cleanup_after ?? undefined,
    status: row.status,
    error: row.error ?? undefined,
    summary: row.summary ?? undefined,
    detail: row.detail_json === null ? undefined : parseCronRunDetailJson(row.detail_json),
  }));
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
    session_key: input.sessionKey ?? null,
    status: existing?.status === "cancelled" ? "cancelled" : input.status,
    ended_at: input.endedAt,
    last_event_at: input.endedAt,
    cleanup_after: input.endedAt + RETENTION_MS,
    error: existing?.status === "cancelled" ? (existing.error ?? null) : (input.error ?? null),
    summary: input.summary ?? existing?.summary ?? null,
    detail_json: JSON.stringify(input.detail),
  };
  if (existing) {
    executeSqliteQuerySync(
      db,
      query(db).updateTable("cron_run_history").set(terminal).where("history_id", "=", existing.id),
    );
  } else {
    executeSqliteQuerySync(
      db,
      query(db)
        .insertInto("cron_run_history")
        .values({
          history_id: randomUUID(),
          job_id: input.jobId,
          agent_id: input.agentId ?? null,
          run_id: input.runId,
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
    executeSqliteQuerySync(
      db,
      query(db).deleteFrom("cron_run_history").where("history_id", "in", batch),
    );
  }
  return ids.length;
}
