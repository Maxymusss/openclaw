import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  RETIRED_TASK_SCHEMA_SQL,
  RETIRED_TASK_TABLES,
} from "./openclaw-state-db-schema-v19-task-source.js";
import {
  insertReleasedRun,
  insertReleasedTask,
  makeReleasedKilledRun,
  readOutcomePayload,
} from "./openclaw-state-db-schema-v19-task-subagent-outcomes.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

function legacyState(version: 17 | 18 = 18, deferred = false) {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("state-v19-retirement-") } };
  const initial = openOpenClawStateDatabase(options);
  if (deferred) {
    createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
  }
  const pathname = initial.path;
  closeOpenClawStateDatabaseForTest();
  const db = new DatabaseSync(pathname);
  db.exec(RETIRED_TASK_SCHEMA_SQL);
  db.exec(`DROP TABLE cron_run_history; PRAGMA user_version = ${version};
    UPDATE schema_meta SET schema_version = ${version};
    DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';`);
  return { options, pathname, db };
}

function markers(db: DatabaseSync) {
  return [
    db.prepare("PRAGMA user_version").get()?.user_version,
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get()
      ?.schema_version,
  ];
}

function retiredObjects(db: DatabaseSync) {
  return db
    .prepare(`SELECT name FROM sqlite_schema WHERE name IN ('task_runs', 'task_delivery_state', 'flow_runs')
    OR tbl_name IN ('task_runs', 'task_delivery_state', 'flow_runs') ORDER BY name`)
    .all();
}

function seedCron(db: DatabaseSync) {
  const insert = db.prepare(`INSERT INTO task_runs (
    task_id, runtime, owner_key, scope_kind, task, delivery_status, notify_policy,
    source_id, run_id, agent_id, child_session_key, created_at, started_at, ended_at,
    last_event_at, cleanup_after, status, error, terminal_summary, detail_json
  ) VALUES (?, 'cron', 'global', 'global', 'history', 'delivered', 'silent',
    ?, ' duplicate run ', ' agent ', ' session ', 100, 101, 102, 103, 999, 'succeeded',
    ' error bytes ', ' summary bytes ', ? )`);
  insert.run("cron-one", "deleted-job", ' { "unknown": [1, 2], "raw": true } ');
  insert.run("cron-two", null, "not-json-preserved");
  return db
    .prepare(`SELECT task_id AS history_id, source_id AS job_id, run_id, agent_id,
    child_session_key AS session_key, created_at, started_at, ended_at, last_event_at,
    cleanup_after, status, error, terminal_summary AS summary, detail_json
    FROM task_runs WHERE runtime = 'cron' ORDER BY task_id`)
    .all();
}

function readRetirementAuditEvidence(db: DatabaseSync) {
  return {
    bindings: db
      .prepare("SELECT * FROM execution_owner_lifecycle_bindings ORDER BY owner_kind, owner_id")
      .all(),
    contexts: db.prepare("SELECT * FROM execution_identity_contexts ORDER BY context_id").all(),
    decisions: db.prepare("SELECT * FROM execution_decision_facts ORDER BY receipt_id").all(),
    events: db.prepare("SELECT * FROM audit_events ORDER BY sequence").all(),
  };
}

function seedRetirementAuditEvidence(db: DatabaseSync) {
  for (const [table, endMarker] of [
    [
      "execution_identity_contexts",
      "ON execution_identity_contexts (run_id, created_at, execution_id);",
    ],
    ["execution_decision_facts", "ON execution_decision_facts (run_id, occurred_at, receipt_id);"],
    ["execution_owner_lifecycle_bindings", undefined],
  ] as const) {
    db.exec(
      extractSqliteTableSchema(
        OPENCLAW_STATE_SCHEMA_SQL,
        table,
        endMarker === undefined ? undefined : { endMarker },
      ),
    );
  }
  const contextJson = ' { "historicalTaskContext": true } ';
  db.prepare(`INSERT INTO execution_identity_contexts (
    context_id, execution_id, run_id, created_at, coverage_state, context_bytes, context_json
  ) VALUES ('shared-context', 'shared-execution', 'shared-run', 100, 'attribution-only', ?, ?)`).run(
    Buffer.byteLength(contextJson),
    contextJson,
  );
  const receiptJson = ' { "owner": "task", "retainGenericDecision": true } ';
  db.prepare(`INSERT INTO execution_decision_facts (
    receipt_id, context_id, execution_id, run_id, action_family, decision_outcome,
    coverage_state, reason_code, owner, source_ref, occurred_at, receipt_bytes, receipt_json
  ) VALUES ('generic-decision', 'shared-context', 'shared-execution', 'shared-run',
    'synthetic-action', 'allowed', 'attribution-only', 'historical', 'task', 'task-source', 101, ?, ?)`).run(
    Buffer.byteLength(receiptJson),
    receiptJson,
  );
  db.exec(`INSERT INTO audit_events (
    event_id, source_id, source_sequence, occurred_at, kind, action, status, actor_type, actor_id, run_id
  ) VALUES ('generic-event', 'generic-source', 1, 102, 'task', 'task.completed',
    'succeeded', 'system', 'gateway', 'shared-run');`);
  const insert = db.prepare(`INSERT INTO execution_owner_lifecycle_bindings
    (owner_kind, owner_id, context_id, execution_id) VALUES (?, 'shared-owner', 'shared-context', 'shared-execution')`);
  // Owner IDs and context IDs can coincide. Match only the two retired kinds,
  // not IDs, substrings, case-folded labels, or the presence of an old Task row.
  for (const kind of ["task", "flow", "cron", "task-other", "Task"]) {
    insert.run(kind);
  }
  return readRetirementAuditEvidence(db);
}

function snapshot(db: DatabaseSync) {
  return {
    schema: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(),
    markers: markers(db),
    metadata: db.prepare("SELECT * FROM schema_meta").all(),
    state: db.prepare("SELECT * FROM config_machine_state ORDER BY state_key").all(),
    tasks: db.prepare("SELECT * FROM task_runs ORDER BY task_id").all(),
    deliveries: db.prepare("SELECT * FROM task_delivery_state ORDER BY task_id").all(),
    runs: db.prepare("SELECT * FROM subagent_runs ORDER BY run_id").all(),
    audit: tableExists(db, "execution_owner_lifecycle_bindings")
      ? readRetirementAuditEvidence(db)
      : undefined,
  };
}

describe("schema 19 Tasks retirement entry points", () => {
  it("creates required Cron history without Tasks tables, FKs, or a unique run ID", () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("state-v19-fresh-") } };
    const { db } = openOpenClawStateDatabase(options);
    expect(markers(db)).toEqual([19, 19]);
    expect(retiredObjects(db)).toEqual([]);
    expect(tableExists(db, "execution_owner_lifecycle_bindings")).toBe(false);
    expect(db.prepare("PRAGMA foreign_key_list(cron_run_history)").all()).toEqual([]);
    expect(db.prepare("PRAGMA index_info(idx_cron_run_history_job)").all()).toEqual([
      { seqno: 0, cid: 1, name: "job_id" },
    ]);
    db.exec(`INSERT INTO cron_run_history(history_id, run_id, created_at, status)
      VALUES ('one', 'same', 1, 'succeeded'), ('two', 'same', 2, 'failed');`);
  });

  it.each([
    { version: 17, doctor: false },
    { version: 18, doctor: false },
    { version: 17, doctor: true },
    { version: 18, doctor: true },
  ] as const)(
    "migrates v$version through doctor=$doctor and reopens without replay",
    ({ version, doctor }) => {
      const { options, db, pathname } = legacyState(version);
      const cron = seedCron(db);
      insertReleasedRun(db);
      insertReleasedTask(db);
      db.exec(
        "PRAGMA foreign_keys = OFF; INSERT INTO task_delivery_state(task_id) VALUES ('orphan');",
      );
      db.exec("INSERT INTO config_machine_state VALUES ('unrelated', '  raw bytes  ', 7);");
      db.close();
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
        kind: "tasks-retirement-v19",
        path: pathname,
      });
      if (doctor) {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      const migrated = openOpenClawStateDatabase(options).db;
      expect(markers(migrated)).toEqual([19, 19]);
      expect(retiredObjects(migrated)).toEqual([]);
      expect(migrated.prepare("SELECT * FROM cron_run_history ORDER BY history_id").all()).toEqual(
        cron,
      );
      expect(readOutcomePayload(migrated)).toMatchObject({
        execution: { status: "terminal", outcome: { status: "ok" }, endedAt: 5_000 },
        completion: { resultText: "durable final result" },
        delivery: { status: "pending", generation: 3, queueId: "retained-queue" },
        endedReason: "subagent-complete",
      });
      expect(
        migrated
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'unrelated'")
          .get(),
      ).toEqual({ value_json: "  raw bytes  " });
      assertSqliteIntegrity(migrated, pathname);
      const native = readOutcomePayload(migrated);
      closeOpenClawStateDatabaseForTest();
      const reopened = openOpenClawStateDatabase(options).db;
      expect(readOutcomePayload(reopened)).toEqual(native);
      expect(reopened.prepare("SELECT * FROM cron_run_history ORDER BY history_id").all()).toEqual(
        cron,
      );
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
    },
  );

  it.each([false, true])(
    "promotes frozen native replies before task-first recovery (parent=%s)",
    (parentEnvelope) => {
      const { options, db } = legacyState();
      insertReleasedRun(
        db,
        makeReleasedKilledRun({
          delivery: { status: "pending", payload: { frozenResultText: "native frozen reply" } },
        }),
        parentEnvelope,
      );
      insertReleasedTask(db);
      db.close();
      const stored = readOutcomePayload(openOpenClawStateDatabase(options).db);
      expect(parentEnvelope ? stored.parentCompletion : stored).toMatchObject({
        completion: { resultText: "native frozen reply" },
        execution: { outcome: { status: "ok" } },
      });
    },
  );

  it.each([false, true])(
    "retires only Task/flow bindings and retains shared audit evidence (doctor=%s)",
    (doctor) => {
      const { options, db } = legacyState();
      const before = seedRetirementAuditEvidence(db);
      db.close();
      if (doctor) {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      const migrated = openOpenClawStateDatabase(options).db;
      const expected = {
        ...before,
        bindings: before.bindings.filter(
          (row) => row.owner_kind !== "task" && row.owner_kind !== "flow",
        ),
      };
      expect(readRetirementAuditEvidence(migrated)).toEqual(expected);
      expect(retiredObjects(migrated)).toEqual([]);
      expect(markers(migrated)).toEqual([19, 19]);
      closeOpenClawStateDatabaseForTest();
      expect(readRetirementAuditEvidence(openOpenClawStateDatabase(options).db)).toEqual(expected);
    },
  );

  it.each([
    "CREATE TRIGGER unexpected_binding_delete AFTER DELETE ON execution_owner_lifecycle_bindings BEGIN DELETE FROM audit_events; END",
    "CREATE TABLE binding_dependent(kind TEXT, id TEXT, FOREIGN KEY(kind, id) REFERENCES execution_owner_lifecycle_bindings(owner_kind, owner_id) ON DELETE CASCADE); INSERT INTO binding_dependent VALUES ('task', 'shared-owner')",
  ])("refuses unknown binding dependencies without deleting audit or dependent rows: %s", (sql) => {
    const { options, db, pathname } = legacyState();
    seedRetirementAuditEvidence(db);
    db.exec(sql);
    const before = snapshot(db);
    db.close();
    expect(repairOpenClawStateDatabaseSchema(options).warnings.length).toBeGreaterThan(0);
    const preserved = new DatabaseSync(pathname);
    try {
      expect(snapshot(preserved)).toEqual(before);
      if (tableExists(preserved, "binding_dependent")) {
        expect(preserved.prepare("SELECT * FROM binding_dependent").all()).toEqual([
          { kind: "task", id: "shared-owner" },
        ]);
      }
    } finally {
      preserved.close();
    }
  });

  it("admits the old updater before shutdown without retiring tables or changing either marker", () => {
    const { options, db, pathname } = legacyState();
    const cron = seedCron(db);
    db.exec(
      "PRAGMA foreign_keys = OFF; INSERT INTO task_delivery_state(task_id, requester_origin_json) VALUES ('orphan', 'preserved upgrade bytes');",
    );
    db.close();
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
    expect(run.steps).toContainEqual(
      expect.objectContaining({
        step: "task-delivery-recovery",
        status: "completed",
        detail: expect.stringContaining("backup and row export"),
      }),
    );
    const admitted = new DatabaseSync(pathname);
    try {
      expect(markers(admitted)).toEqual([18, 18]);
      expect(retiredObjects(admitted).length).toBeGreaterThan(0);
      expect(
        admitted.prepare("SELECT COUNT(*) AS count FROM task_runs WHERE runtime = 'cron'").get(),
      ).toEqual({ count: cron.length });
      expect(admitted.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        admitted.prepare("SELECT name FROM sqlite_schema WHERE name = 'cron_run_history'").get(),
      ).toBeUndefined();
    } finally {
      admitted.close();
    }
  });

  it("does not let old updater admission recover an unrelated foreign-key violation", () => {
    const { options, db, pathname } = legacyState();
    db.exec(
      "PRAGMA foreign_keys = OFF; INSERT INTO task_delivery_state(task_id) VALUES ('orphan'); CREATE TABLE unrelated_parent(id TEXT PRIMARY KEY); CREATE TABLE unrelated_child(id TEXT REFERENCES unrelated_parent(id)); INSERT INTO unrelated_child VALUES ('orphan');",
    );
    const before = snapshot(db);
    db.close();
    expect(() => createUpdateRun({ trigger: "cli" }, options)).toThrow(/foreign_key_check/);
    const preserved = new DatabaseSync(pathname);
    try {
      expect(snapshot(preserved)).toEqual(before);
    } finally {
      preserved.close();
    }
  });

  it("defers both published markers while recording content 19, and never repeats retirement", () => {
    const { options, db } = legacyState(18, true);
    const cron = seedCron(db);
    db.close();
    const migrated = openOpenClawStateDatabase(options).db;
    expect(markers(migrated)).toEqual([18, 18]);
    expect(
      migrated
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
        )
        .get(),
    ).toEqual({ value_json: "19" });
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options).db;
    expect(markers(reopened)).toEqual([18, 18]);
    expect(retiredObjects(reopened)).toEqual([]);
    expect(reopened.prepare("SELECT * FROM cron_run_history ORDER BY history_id").all()).toEqual(
      cron,
    );
  });

  it("inspects old read-only state without applying retirement or changing rows", async () => {
    const { options, db, pathname } = legacyState();
    seedCron(db);
    const before = snapshot(db);
    db.close();
    const reader = await openExistingOpenClawStateDatabaseReadOnly(options);
    expect(reader).toBeDefined();
    try {
      expect(snapshot(reader!.db)).toEqual(before);
    } finally {
      reader?.walMaintenance.close();
    }
    const after = new DatabaseSync(pathname, { readOnly: true });
    try {
      expect(snapshot(after)).toEqual(before);
    } finally {
      after.close();
    }
  });

  it.each([
    "ALTER TABLE task_runs ADD COLUMN unknown TEXT",
    "CREATE INDEX unknown_task_index ON task_runs(label)",
    "CREATE VIEW retained_view AS SELECT * FROM task_runs",
    "CREATE TRIGGER retained_trigger AFTER INSERT ON config_machine_state BEGIN SELECT * FROM task_runs; END",
    "CREATE TABLE retained_child(id TEXT REFERENCES task_runs(task_id) ON DELETE CASCADE)",
    "CREATE TABLE retained_delivery(id TEXT REFERENCES task_delivery_state(task_id) ON DELETE SET NULL)",
    "INSERT INTO task_delivery_state(task_id) VALUES ('orphan2'), ('orphan3'), ('orphan4'), ('orphan5'), ('orphan6'); CREATE TABLE other_parent(id TEXT PRIMARY KEY); CREATE TABLE zz_other_child(id TEXT REFERENCES other_parent(id)); INSERT INTO zz_other_child VALUES ('missing')",
  ])("refuses unknown dependencies/drift and preserves every row: %s", (sql) => {
    const { options, db, pathname } = legacyState();
    seedCron(db);
    insertReleasedRun(db);
    insertReleasedTask(db);
    db.exec(
      "PRAGMA foreign_keys = OFF; INSERT INTO task_delivery_state(task_id) VALUES ('orphan');",
    );
    db.exec(sql);
    const before = snapshot(db);
    db.close();
    expect(repairOpenClawStateDatabaseSchema(options).warnings.length).toBeGreaterThan(0);
    const after = new DatabaseSync(pathname);
    try {
      expect(snapshot(after)).toEqual(before);
    } finally {
      after.close();
    }
  });

  it("rolls back extracted native and Cron data when final schema validation refuses", () => {
    const { options, db, pathname } = legacyState();
    seedCron(db);
    insertReleasedRun(db);
    insertReleasedTask(db);
    seedRetirementAuditEvidence(db);
    // This unrelated drift fails the final canonical assertion after extraction.
    db.exec("ALTER TABLE apns_registrations ADD COLUMN unknown INTEGER NOT NULL DEFAULT 0;");
    const before = snapshot(db);
    db.close();
    expect(repairOpenClawStateDatabaseSchema(options).warnings.length).toBeGreaterThan(0);
    const after = new DatabaseSync(pathname);
    try {
      expect(snapshot(after)).toEqual(before);
      expect(
        after.prepare("SELECT name FROM sqlite_schema WHERE name = 'cron_run_history'").get(),
      ).toBeUndefined();
      expect(
        RETIRED_TASK_TABLES.every((table) =>
          after.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(table),
        ),
      ).toBe(true);
    } finally {
      after.close();
    }
  });
});
