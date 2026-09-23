import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { migrateLegacyTaskSubagentOutcomes } from "./openclaw-state-db-schema-v19-task-subagent-outcomes.js";
import {
  insertReleasedRun,
  insertReleasedTask,
  makeReleasedKilledRun,
  outcomeDatabaseSnapshot,
  readOutcomePayload,
  RELEASED_OUTCOME_TABLES,
} from "./openclaw-state-db-schema-v19-task-subagent-outcomes.test-support.js";

const databases = new Set<DatabaseSync>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.clear();
    cleanup();
  });
});

function openDatabase(filename = ":memory:", initialize = true): DatabaseSync {
  const db = new DatabaseSync(filename);
  databases.add(db);
  if (initialize) {
    db.exec(RELEASED_OUTCOME_TABLES);
  }
  return db;
}

function closeDatabase(db: DatabaseSync): void {
  db.close();
  databases.delete(db);
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrate(db: DatabaseSync): number {
  return transaction(db, () => migrateLegacyTaskSubagentOutcomes(db));
}

function seed(db: DatabaseSync): void {
  insertReleasedRun(db);
  insertReleasedTask(db);
}

function insertSteerRun(db: DatabaseSync, explicitBinding: boolean): void {
  insertReleasedRun(
    db,
    makeReleasedKilledRun({
      runId: "replacement-run",
      ...(explicitBinding ? { taskRunId: "original-run" } : {}),
      createdAt: 100_000,
      sessionStartedAt: 1_000,
      generation: 2,
      runTimeoutSeconds: 10,
      execution: {
        status: "terminal",
        startedAt: 100_000,
        endedAt: 104_000,
        outcome: { status: "error", error: "manual kill" },
      },
      killReconciliation: { killedAt: 104_000 },
    }),
  );
  insertReleasedTask(db, { runId: "original-run", endedAt: 105_000 });
}

describe("v19 released task-first subagent outcome migration", () => {
  it.each([
    { status: "succeeded", outcome: "ok", reason: "subagent-complete", error: null },
    { status: "failed", outcome: "error", reason: "subagent-error", error: "provider failed" },
    { status: "timed_out", outcome: "timeout", reason: "subagent-complete", error: null },
  ])("recovers released $status without changing delivery or authority", (testCase) => {
    const db = openDatabase();
    const run = makeReleasedKilledRun();
    insertReleasedRun(db, run);
    insertReleasedTask(db, { status: testCase.status, error: testCase.error });
    const before = outcomeDatabaseSnapshot(db);

    expect(migrate(db)).toBe(1);
    const expected: Record<string, unknown> = {
      ...run,
      execution: {
        ...asNullableRecord(run.execution),
        endedAt: 5_000,
        outcome: {
          status: testCase.outcome,
          ...(testCase.error === null ? {} : { error: testCase.error }),
          startedAt: 1_000,
          endedAt: 5_000,
          elapsedMs: 4_000,
        },
      },
      completion: { required: true, resultText: "durable final result", capturedAt: 5_000 },
      endedReason: testCase.reason,
    };
    delete expected.killReconciliation;
    delete expected.suppressAnnounceReason;
    expect(readOutcomePayload(db)).toEqual(expected);
    const after = outcomeDatabaseSnapshot(db);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.schema).toEqual(before.schema);
    expect(after.version).toEqual(before.version);
    expect(after.runs.map(({ payload_json: _payload, ...identity }) => identity)).toEqual(
      before.runs.map(({ payload_json: _payload, ...identity }) => identity),
    );
    expect(migrate(db)).toBe(0);
    expect(outcomeDatabaseSnapshot(db)).toEqual(after);
  });

  it.each([
    { progressSummary: null, terminalSummary: "terminal fallback", result: "terminal fallback" },
    { progressSummary: "", terminalSummary: "not selected", result: "" },
    { progressSummary: "NO_REPLY", terminalSummary: "not selected", result: "NO_REPLY" },
    { progressSummary: null, terminalSummary: null, result: null },
  ])("preserves released nullish summary precedence: $result", (testCase) => {
    const db = openDatabase();
    insertReleasedRun(db);
    insertReleasedTask(db, testCase);
    expect(migrate(db)).toBe(1);
    expect(readOutcomePayload(db).completion).toEqual({
      required: true,
      resultText: testCase.result,
      capturedAt: 5_000,
    });
  });

  it.each([
    { resultText: "canonical native result", capturedAt: 3_000 },
    { resultText: null, capturedAt: 3_000 },
    { resultText: "", capturedAt: 3_000 },
    { terminalReply: { disposition: "silent" } },
    { terminalReply: { disposition: "empty" } },
    { terminalReply: { disposition: "visible", text: "producer-owned result" } },
    { fallbackResultText: "promoted frozen result", fallbackCapturedAt: 3_000 },
  ])("does not replace native completion evidence %#", (capture) => {
    const db = openDatabase();
    const completion = { required: true, ...capture };
    insertReleasedRun(db, makeReleasedKilledRun({ completion }));
    insertReleasedTask(db);
    expect(migrate(db)).toBe(1);
    expect(readOutcomePayload(db).completion).toEqual(completion);
  });

  it.each(["pending", "in_progress", "delivered", "suspended", "not_required"])(
    "keeps %s delivery, its queue/receipt identities, and suppression sticky",
    (status) => {
      const db = openDatabase();
      const delivery = {
        status,
        disposition: "intentional_non_delivery",
        queueId: "same-physical-queue",
        generation: 9,
        attemptCount: 2,
        steeringLeaseId: "same-lease",
        announcedAt: 3_000,
        requesterVisibleFinal: { requesterTurnRunId: "same-turn", batchRunIds: ["physical-run"] },
        payload: { childRunId: "physical-run", endedAt: 4_000, outcome: { status: "error" } },
      };
      insertReleasedRun(
        db,
        makeReleasedKilledRun({
          delivery,
          killReconciliation: { killedAt: 4_000, suppressTaskDelivery: true },
        }),
      );
      insertReleasedTask(db);
      expect(migrate(db)).toBe(1);
      expect(readOutcomePayload(db)).toMatchObject({ delivery, suppressCompletionDelivery: true });
    },
  );

  it("keeps an existing delivery suppression even without the provisional marker flag", () => {
    const db = openDatabase();
    insertReleasedRun(db, makeReleasedKilledRun({ suppressCompletionDelivery: true }));
    insertReleasedTask(db);
    expect(migrate(db)).toBe(1);
    expect(readOutcomePayload(db).suppressCompletionDelivery).toBe(true);
  });

  it("uses an explicit binding instead of a competing physical-run task", () => {
    const db = openDatabase();
    insertSteerRun(db, true);
    insertReleasedTask(db, {
      taskId: "wrong-direct-task",
      runId: "replacement-run",
      status: "failed",
      createdAt: 100_000,
      startedAt: 100_000,
      endedAt: 105_000,
      progressSummary: "wrong result",
    });
    expect(migrate(db)).toBe(1);
    expect(readOutcomePayload(db, "replacement-run")).toMatchObject({
      runId: "replacement-run",
      taskRunId: "original-run",
      execution: {
        startedAt: 100_000,
        endedAt: 105_000,
        outcome: { status: "ok", startedAt: 100_000, endedAt: 105_000, elapsedMs: 5_000 },
      },
      completion: { resultText: "durable final result" },
    });
  });

  it("applies the current steer deadline, not the original task start", () => {
    const db = openDatabase();
    insertSteerRun(db, true);
    db.exec("UPDATE task_runs SET ended_at = 115000");
    expect(migrate(db)).toBe(1);
    expect(readOutcomePayload(db, "replacement-run")).toMatchObject({
      execution: {
        endedAt: 110_000,
        outcome: { status: "timeout", startedAt: 100_000, endedAt: 110_000, elapsedMs: 10_000 },
      },
      completion: { resultText: "durable final result", capturedAt: 115_000 },
    });
  });

  it("recovers the unique v2026.6.34 steer binding without retaining a Task owner", () => {
    const db = openDatabase();
    insertSteerRun(db, false);
    db.exec(
      "UPDATE task_runs SET run_id = char(9) || run_id || char(160), child_session_key = ' ' || child_session_key || ' '",
    );
    expect(migrate(db)).toBe(1);
    const run = readOutcomePayload(db, "replacement-run");
    expect(run).toMatchObject({
      execution: { outcome: { status: "ok", startedAt: 100_000 } },
      completion: { resultText: "durable final result" },
    });
    expect(run).not.toHaveProperty("taskRunId");
  });

  it("does not rename physical run IDs or unwrap parent-only completion envelopes", () => {
    const db = openDatabase();
    const physicalRunId = "\tphysical-run\u00a0";
    const run = makeReleasedKilledRun({ runId: physicalRunId });
    insertReleasedRun(db, run, true);
    insertReleasedTask(db);
    expect(migrate(db)).toBe(1);
    expect(db.prepare("SELECT run_id FROM subagent_runs").all()).toEqual([
      { run_id: physicalRunId },
    ]);
    expect(readOutcomePayload(db, physicalRunId)).toMatchObject({
      envelope: "kept",
      parentCompletion: {
        runId: physicalRunId,
        completionTarget: "parent",
        execution: { outcome: { status: "ok" } },
        completion: { resultText: "durable final result" },
        requesterSettleWake: run.requesterSettleWake,
        delivery: run.delivery,
      },
    });
  });

  it.each([
    [
      "no provisional kill",
      "UPDATE subagent_runs SET payload_json = json_remove(payload_json, '$.killReconciliation')",
    ],
    [
      "canonical completion",
      "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.endedReason', 'subagent-complete', '$.execution.outcome.status', 'ok')",
    ],
    [
      "running native execution",
      "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.execution.status', 'running')",
    ],
    [
      "durable kill intent",
      "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.killIntent', json_object('requestedAt', 4000, 'reason', 'stop'))",
    ],
    [
      "superseded tombstone",
      "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.killReconciliation.supersededAt', 4500)",
    ],
    [
      "yielded native row",
      "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.pauseReason', 'sessions_yield')",
    ],
    [
      "invalid generation",
      "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.generation', 'unknown')",
    ],
    [
      "invalid session start",
      "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.sessionStartedAt', 'unknown')",
    ],
    [
      "invalid execution start",
      "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.execution.startedAt', 'unknown')",
    ],
    ["different requester", "UPDATE task_runs SET requester_session_key = 'another-requester'"],
    ["different child", "UPDATE task_runs SET child_session_key = 'another-child'"],
    ["another runtime", "UPDATE task_runs SET runtime = 'cron'"],
    ["unbound run", "UPDATE task_runs SET run_id = 'unrelated-run'"],
    ["missing terminal timestamp", "UPDATE task_runs SET ended_at = NULL"],
    ["task before this session", "UPDATE task_runs SET created_at = 999"],
    ["completion before this generation", "UPDATE task_runs SET ended_at = 999"],
    ["task created after its completion", "UPDATE task_runs SET created_at = 5001"],
    [
      "contradictory native identity",
      "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.requesterSessionKey', 'another-requester')",
    ],
    ["cancelled task", "UPDATE task_runs SET status = 'cancelled'"],
    ["running task", "UPDATE task_runs SET status = 'running'"],
    ["queued task", "UPDATE task_runs SET status = 'queued'"],
    ["lost task", "UPDATE task_runs SET status = 'lost'"],
  ])("leaves %s byte-for-byte unchanged", (_name, sql) => {
    const db = openDatabase();
    seed(db);
    db.exec(sql);
    const before = outcomeDatabaseSnapshot(db);
    expect(migrate(db)).toBe(0);
    expect(outcomeDatabaseSnapshot(db)).toEqual(before);
  });

  it.each(["unknown-run", null, "", 42])(
    "does not fall back from explicit binding %j",
    (binding) => {
      const db = openDatabase();
      insertSteerRun(db, false);
      db.prepare(
        "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.taskRunId', ?)",
      ).run(binding);
      const before = outcomeDatabaseSnapshot(db);
      expect(migrate(db)).toBe(0);
      expect(outcomeDatabaseSnapshot(db)).toEqual(before);
    },
  );

  it.each([
    "same-run",
    "trim-collision",
    "another-runtime",
    "native-claim",
    "new-generation",
    "same-time",
  ])("rejects ambiguous or superseded binding: %s", (kind) => {
    const db = openDatabase();
    seed(db);
    if (kind === "same-run" || kind === "trim-collision" || kind === "another-runtime") {
      insertReleasedTask(db, {
        taskId: "second-task",
        runId: kind === "trim-collision" ? " physical-run " : "physical-run",
        runtime: kind === "another-runtime" ? "cron" : "subagent",
      });
    } else {
      insertReleasedRun(
        db,
        makeReleasedKilledRun({
          runId: "second-native",
          childSessionKey:
            kind === "native-claim" ? "another-child" : "agent:worker:subagent:child",
          ...(kind === "native-claim" ? { taskRunId: " physical-run " } : {}),
          generation: kind === "new-generation" ? 2 : 1,
          createdAt: kind === "new-generation" ? 6_000 : 1_000,
        }),
      );
    }
    const before = outcomeDatabaseSnapshot(db);
    expect(migrate(db)).toBe(0);
    expect(outcomeDatabaseSnapshot(db)).toEqual(before);
  });

  it.each([
    "second-task",
    "second-run",
    "wrong-requester",
    "before-session",
    "after-replacement",
    "no-session-start",
  ])("does not guess a v2026.6.34 continuation: %s", (kind) => {
    const db = openDatabase();
    insertSteerRun(db, false);
    if (kind === "second-task") {
      insertReleasedTask(db, { taskId: "second-task", runId: "another-run", endedAt: 105_000 });
    } else if (kind === "second-run") {
      insertReleasedRun(db, makeReleasedKilledRun({ runId: "older-run" }));
    } else if (kind === "wrong-requester") {
      db.exec("UPDATE task_runs SET requester_session_key = 'another-requester'");
    } else if (kind === "no-session-start") {
      db.exec(
        "UPDATE subagent_runs SET payload_json = json_remove(payload_json, '$.sessionStartedAt')",
      );
    } else {
      db.prepare("UPDATE task_runs SET created_at = ?").run(
        kind === "before-session" ? 999 : 100_001,
      );
    }
    const before = outcomeDatabaseSnapshot(db);
    expect(migrate(db)).toBe(0);
    expect(outcomeDatabaseSnapshot(db)).toEqual(before);
  });

  it("requires the owner transaction and v13 canonicalization", () => {
    const db = openDatabase();
    seed(db);
    const before = outcomeDatabaseSnapshot(db);
    expect(() => migrateLegacyTaskSubagentOutcomes(db)).toThrow("schema migration transaction");
    expect(outcomeDatabaseSnapshot(db)).toEqual(before);
    db.exec("ALTER TABLE subagent_runs ADD COLUMN task TEXT");
    const wide = outcomeDatabaseSnapshot(db);
    expect(() => migrate(db)).toThrow("after v13");
    expect(outcomeDatabaseSnapshot(db)).toEqual(wide);
  });

  it("keeps recovered results across Task deletion, commit, and reopen without rearming delivery", () => {
    const filename = path.join(tempDirs.make("openclaw-task-outcomes-"), "state.sqlite");
    const db = openDatabase(filename);
    seed(db);
    transaction(db, () => {
      expect(migrateLegacyTaskSubagentOutcomes(db)).toBe(1);
      db.exec("DROP TABLE task_runs; PRAGMA user_version = 19");
    });
    const savedRuns = db.prepare("SELECT * FROM subagent_runs").all();
    closeDatabase(db);
    const reopened = openDatabase(filename, false);
    expect(reopened.prepare("SELECT * FROM subagent_runs").all()).toEqual(savedRuns);
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: 19 });
    expect(migrate(reopened)).toBe(0);
    expect(
      reopened.prepare("SELECT name FROM sqlite_schema WHERE name = 'task_runs'").get(),
    ).toBeUndefined();
    expect(reopened.prepare("SELECT * FROM subagent_runs").all()).toEqual(savedRuns);
  });

  it("rolls back native recovery together with a later Task-drop failure", () => {
    const filename = path.join(tempDirs.make("openclaw-task-outcome-rollback-"), "state.sqlite");
    const db = openDatabase(filename);
    seed(db);
    const before = outcomeDatabaseSnapshot(db);
    expect(() =>
      transaction(db, () => {
        expect(migrateLegacyTaskSubagentOutcomes(db)).toBe(1);
        db.exec("DROP TABLE task_runs; PRAGMA user_version = 19");
        throw new Error("later migration failed");
      }),
    ).toThrow("later migration failed");
    expect(outcomeDatabaseSnapshot(db)).toEqual(before);
    closeDatabase(db);
    const reopened = openDatabase(filename, false);
    expect(outcomeDatabaseSnapshot(reopened)).toEqual(before);
    expect(migrate(reopened)).toBe(1);
  });

  it("propagates a native write failure so the owner rolls back all earlier payloads", () => {
    const db = openDatabase();
    seed(db);
    insertReleasedRun(
      db,
      makeReleasedKilledRun({ runId: "second-run", childSessionKey: "second-child" }),
    );
    insertReleasedTask(db, {
      taskId: "second-task",
      runId: "second-run",
      childSessionKey: "second-child",
    });
    db.exec(`
      CREATE TRIGGER fail_second_outcome AFTER UPDATE ON subagent_runs
      WHEN (SELECT count(*) FROM subagent_runs
        WHERE json_extract(payload_json, '$.endedReason') = 'subagent-complete') = 2
      BEGIN SELECT RAISE(ABORT, 'injected native payload failure'); END;
    `);
    const before = outcomeDatabaseSnapshot(db);
    expect(() => migrate(db)).toThrow("injected native payload failure");
    expect(outcomeDatabaseSnapshot(db)).toEqual(before);
  });
});
