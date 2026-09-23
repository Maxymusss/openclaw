import { expect, it } from "vitest";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  cronQuietTriggerDetail,
  cronRunLogEntryToDetail,
  cronRunRecordToRunLogEntry,
} from "./run-history-detail.js";
import { projectCronRunHistoryPage, readCronRunHistoryPage } from "./run-history.js";
import { findCronRunRecoveryInDatabase } from "./service/run-history-recovery.js";
import { cronStoreKey } from "./store/key.js";
import {
  collectExpiredCronRunIds,
  CRON_HISTORY_KEEP_PER_JOB,
  readCronRunRecordsInDatabase,
  recordCronRunInDatabase,
} from "./store/run-history.kernel.js";
import type { CronRunHistoryWrite, CronRunRecord } from "./store/run-history.types.js";

function outcome(storeKey: string, receipt: string): CronRunHistoryWrite {
  return {
    storeKey,
    jobId: "job",
    runId: `cron:job:10:${receipt}`,
    agentId: "main",
    startedAt: 10,
    endedAt: 20,
    sessionKey: "agent:main:cron:job",
    status: "succeeded",
    detail: cronRunLogEntryToDetail(
      {
        jobId: "job",
        action: "finished",
        ts: 20,
        runAtMs: 10,
        status: "ok",
        completionStatus: "succeeded",
        sessionId: "recorded-generation",
        runId: receipt,
      },
      { storeKey },
    ),
  };
}

it("retains history across worker reads, isolates stores, and recovers only an exact receipt", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-native-history-" },
    async (state) => {
      const storeKey = cronStoreKey(state.statePath("cron/jobs.json"));
      runOpenClawStateWriteTransaction(({ db }) => {
        recordCronRunInDatabase(db, outcome(storeKey, "first"));
        recordCronRunInDatabase(db, outcome(storeKey, "second"));
        recordCronRunInDatabase(db, outcome(storeKey + "-other", "first"));
        const recovered = findCronRunRecoveryInDatabase({
          database: db,
          storeKey,
          jobId: "job",
          startedAt: 10,
          receiptId: "second",
        });
        expect(recovered.finalized?.entry).toMatchObject({
          runId: "second",
          sessionId: "recorded-generation",
        });
        expect(
          findCronRunRecoveryInDatabase({
            database: db,
            storeKey,
            jobId: "job",
            startedAt: 10,
            receiptId: "missing",
          }).finalized,
        ).toBeUndefined();
        // A late result cannot replace the first durable outcome for this exact run.
        recordCronRunInDatabase(db, {
          ...outcome(storeKey, "first"),
          status: "failed",
          endedAt: 40,
        });
        expect(
          readCronRunRecordsInDatabase(db, "job").find((row) => row.runId === "cron:job:10:first")
            ?.endedAt,
        ).toBe(20);
      });
      const history = await readCronRunHistoryPage({
        storeKey,
        jobId: "job",
        limit: 1,
        sortDir: "asc",
      });
      expect(history).toMatchObject({ total: 2, limit: 1, hasMore: true, nextOffset: 1 });
      expect(history.entries[0]?.sessionId).toBe("recorded-generation");
      expect(
        (await readCronRunHistoryPage({ storeKey, jobId: "job", runId: "second" })).entries,
      ).toHaveLength(1);
    },
  );
});

it("bounds quiet evaluations separately without evicting payload history or active recovery markers", () => {
  const records: CronRunRecord[] = Array.from(
    { length: CRON_HISTORY_KEEP_PER_JOB + 1 },
    (_, index) => ({
      id: String(index),
      jobId: "job",
      createdAt: index,
      endedAt: index,
      status: "succeeded",
      detail: cronQuietTriggerDetail("store", { fired: false, stateChanged: false }),
    }),
  );
  const history: CronRunRecord = {
    id: "history",
    jobId: "job",
    createdAt: 0,
    endedAt: 0,
    status: "succeeded",
    detail: outcome("store", "history").detail,
  };
  const active: CronRunRecord = { id: "active", jobId: "job", createdAt: 0, status: "running" };
  expect(collectExpiredCronRunIds([...records, history, active], 3000)).toEqual(new Set(["0"]));
  expect(collectExpiredCronRunIds([history, active], 7 * 24 * 60 * 60_000)).toEqual(
    new Set(["history"]),
  );
  expect(
    projectCronRunHistoryPage([...records, history], { storeKey: "store", jobId: "job" }).total,
  ).toBe(1);
});

it("reads released row fallback fields but never discloses internal recovery state", () => {
  const record: CronRunRecord = {
    id: "released",
    jobId: "job",
    createdAt: 1,
    endedAt: 2,
    status: "cancelled",
    error: "operator reason",
    summary: "old summary",
    sessionKey: "agent:main:cron:job",
    detail: {
      kind: "cron-run",
      status: "ok",
      storeKey: "store",
      sessionId: "old-generation",
      triggerState: { secret: true },
      futureInternal: "private",
    },
  };
  const entry = cronRunRecordToRunLogEntry(record);
  expect(entry).toMatchObject({
    error: "operator reason",
    summary: "old summary",
    sessionId: "old-generation",
  });
  expect(entry).not.toHaveProperty("triggerState");
  expect(entry).not.toHaveProperty("futureInternal");
  expect(entry).not.toHaveProperty("storeKey");
});
