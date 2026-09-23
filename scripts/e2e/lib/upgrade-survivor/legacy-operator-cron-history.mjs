import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const MIGRATION = "state:cron-run-logs-to-task-runs:v1";
const FIXTURE_NAME = "legacy-operator-cron-history.json";
const BASELINE_SCHEMAS = { "2026.9.2": 15, "2026.9.3": 16, "2026.9.4": 17 };
const RETIRED_TABLES = ["task_delivery_state", "task_runs", "flow_runs"];
const RETIRED_INDEXES = [
  "idx_task_runs_run_id",
  "idx_task_runs_status",
  "idx_task_runs_runtime_status",
  "idx_task_runs_cleanup_after",
  "idx_task_runs_last_event_at",
  "idx_task_runs_owner_key",
  "idx_task_runs_parent_flow_id",
  "idx_task_runs_child_session_key",
  "idx_task_runs_requester_session_key",
  "idx_task_runs_runtime_source_ended",
  "idx_task_runs_runtime_ended",
  "idx_flow_runs_status",
  "idx_flow_runs_owner_key",
  "idx_flow_runs_updated_at",
];
const PRESERVED_MIGRATION = "survivor:unrelated-history:v1";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

function identity(manifestBytes, buildBytes) {
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(manifest.name, "openclaw");
  JSON.parse(buildBytes.toString());
  return {
    version: manifest.version,
    stateSchemaVersion: manifest.openclaw.schemaVersions.state,
    manifestSha256: hash(manifestBytes),
    buildInfoSha256: hash(buildBytes),
  };
}

function installedIdentity(root) {
  return identity(
    fs.readFileSync(path.join(root, "package.json")),
    fs.readFileSync(path.join(root, "dist/build-info.json")),
  );
}

export function snapshotCronHistory(fixture) {
  const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    // All facts describe one committed state. Never invoke a runtime opener or repair.
    db.exec("BEGIN");
    const stateSchemaVersion = db.prepare("PRAGMA user_version").get().user_version;
    const metadataVersion = db
      .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
      .get()?.schema_version;
    assert.equal(metadataVersion, stateSchemaVersion, "published schema markers disagree");
    const marker = db
      .prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
      )
      .get();
    const recordedContent = marker ? JSON.parse(marker.value_json) : stateSchemaVersion;
    assert(
      Number.isSafeInteger(recordedContent) && recordedContent >= 0,
      "invalid content version",
    );
    const contentVersion = Math.max(stateSchemaVersion, recordedContent);
    const retiredObjects = db
      .prepare(`SELECT type, name FROM sqlite_schema
        WHERE name IN (${[...RETIRED_TABLES, ...RETIRED_INDEXES].map(() => "?").join(",")})
        ORDER BY type, name`)
      .all(...RETIRED_TABLES, ...RETIRED_INDEXES);
    const legacySchema = db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'cron_run_logs'")
      .get()?.sql;
    const legacyRows = legacySchema
      ? db
          .prepare("SELECT * FROM cron_run_logs ORDER BY store_key, job_id, seq")
          .all()
          .map((row) => Object.assign({}, row))
      : [];
    // Select the declared content contract, not whichever table happens to exist.
    const history = db
      .prepare(
        contentVersion >= 19
          ? `SELECT history_id, job_id, run_id, agent_id, session_key, created_at, started_at,
          ended_at, last_event_at, cleanup_after, status, error, summary, detail_json
         FROM cron_run_history ORDER BY history_id`
          : `SELECT task_id AS history_id, source_id AS job_id, run_id, agent_id,
          child_session_key AS session_key, created_at, started_at, ended_at, last_event_at,
          cleanup_after, status, error, terminal_summary AS summary, detail_json
         FROM task_runs WHERE runtime = 'cron' ORDER BY task_id`,
      )
      .all()
      .map((row) => Object.assign({}, row));
    const jobs = new Set(fixture.entries.map((entry) => entry.jobId));
    const unrelatedMigration = db
      .prepare("SELECT * FROM migration_runs WHERE id = ?")
      .get(PRESERVED_MIGRATION);
    const cronReceipt = db
      .prepare("SELECT * FROM cron_run_receipts WHERE receipt_id = ?")
      .get(PRESERVED_MIGRATION);
    const migration = db.prepare("SELECT * FROM migration_runs WHERE id = ?").get(MIGRATION);
    return {
      stateSchemaVersion,
      metadataVersion,
      contentVersion,
      retiredObjects,
      legacySchema: legacySchema ?? null,
      legacyRows,
      legacySha256: hash(JSON.stringify({ legacySchema: legacySchema ?? null, legacyRows })),
      history: history.filter((row) => jobs.has(row.job_id)),
      unrelatedHistory: history.filter((row) => !jobs.has(row.job_id)),
      unrelatedMigration: unrelatedMigration ? Object.assign({}, unrelatedMigration) : null,
      cronReceipt: cronReceipt ? Object.assign({}, cronReceipt) : null,
      migration: migration ? Object.assign({}, migration) : null,
    };
  } finally {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    db.close();
  }
}

export function seedCronHistory(stateDir, artifactRoot, baselineRoot, candidateTarball) {
  const baseline = installedIdentity(baselineRoot);
  assert(Object.hasOwn(BASELINE_SCHEMAS, baseline.version));
  const packed = (name) =>
    execFileSync("tar", ["-xOf", candidateTarball, `package/${name}`], {
      maxBuffer: 1024 * 1024,
    });
  const candidate = identity(packed("package.json"), packed("dist/build-info.json"));
  assert(
    Number.isSafeInteger(candidate.stateSchemaVersion) &&
      candidate.stateSchemaVersion >= baseline.stateSchemaVersion,
    "retained-history candidate must declare a valid nonolder state schema",
  );
  assert.notEqual(baseline.buildInfoSha256, candidate.buildInfoSha256);
  const jobs = readJson(path.join(artifactRoot, "legacy-operator-baseline.json")).jobs;
  assert.equal(jobs.length, 2);
  const fixture = {
    baseline,
    candidate,
    databasePath: path.join(stateDir, "state/openclaw.sqlite"),
    storeKey: path.resolve(stateDir, "cron/jobs.json"),
    entries: jobs.map((job, index) => ({
      jobId: job.id,
      action: "finished",
      ts: 1_800_000_000_100 + index * 1000,
      runAtMs: 1_800_000_000_000 + index * 1000,
      durationMs: 100,
      runId: `survivor-retained-cron-${index}`,
      status: index === 0 ? "ok" : "error",
      completionStatus: index === 0 ? "succeeded" : "failed",
      deliveryStatus: "not-requested",
      summary: `retained cron history ${index}`,
      error: index === 1 ? "synthetic retained failure" : undefined,
    })),
  };
  const db = new DatabaseSync(fixture.databasePath);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, baseline.stateSchemaVersion);
    assert.equal(baseline.stateSchemaVersion, BASELINE_SCHEMAS[baseline.version]);
    // A retained historical table is the specimen; executing a modern cron job
    // writes task_runs directly and would never exercise this import boundary.
    db.exec(`CREATE TABLE cron_run_logs (
      store_key TEXT NOT NULL, job_id TEXT NOT NULL, seq INTEGER NOT NULL,
      ts INTEGER NOT NULL, entry_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (store_key, job_id, seq)
    ) STRICT;`);
    const insert = db.prepare("INSERT INTO cron_run_logs VALUES (?, ?, ?, ?, ?, ?)");
    for (const entry of fixture.entries) {
      insert.run(fixture.storeKey, entry.jobId, 1, entry.ts, JSON.stringify(entry), entry.ts);
    }
    // Independent released history and receipts must survive the cutover byte-for-byte.
    db.prepare(`INSERT INTO task_runs (task_id, runtime, source_id, owner_key, scope_kind,
      task, status, delivery_status, notify_policy, created_at, ended_at, terminal_summary, detail_json)
      VALUES (?, 'cron', 'survivor-deleted-job', '', 'system', 'deleted job', 'succeeded',
        'not_applicable', 'silent', 1800000000000, 1800000000100, 'unrelated history', ?)`).run(
      PRESERVED_MIGRATION,
      '{ "kind": "cron-run", "summary": "raw bytes", "future": [1, 2] }',
    );
    db.prepare("INSERT INTO migration_runs VALUES (?, 10, 20, 'completed', ?)").run(
      PRESERVED_MIGRATION,
      '{ "preserved": true }',
    );
    // This first-use table has the same released definition in all three baselines.
    db.exec(`CREATE TABLE IF NOT EXISTS cron_run_receipts (
      receipt_id TEXT PRIMARY KEY, store_key TEXT NOT NULL, job_id TEXT NOT NULL,
      config_revision TEXT NOT NULL, agent_id TEXT NOT NULL, request_run_id TEXT,
      status TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_start_time INTEGER,
      started_at_ms INTEGER NOT NULL, finished_at_ms INTEGER, error_text TEXT,
      CHECK (status IN ('running', 'ok', 'error', 'skipped', 'interrupted', 'superseded')),
      CHECK ((status = 'running' AND finished_at_ms IS NULL)
        OR (status != 'running' AND finished_at_ms IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_run_receipts_active_job
      ON cron_run_receipts(store_key, job_id) WHERE status = 'running';
    CREATE INDEX IF NOT EXISTS idx_cron_run_receipts_job_history
      ON cron_run_receipts(store_key, job_id, started_at_ms DESC, receipt_id DESC);`);
    db.prepare(`INSERT INTO cron_run_receipts VALUES
      (?, ?, 'survivor-deleted-job', 'retained-revision', 'main', 'retained-run',
       'ok', 1, NULL, 1800000000000, 1800000000100, NULL)`).run(
      PRESERVED_MIGRATION,
      fixture.storeKey,
    );
  } finally {
    db.close();
  }
  const before = snapshotCronHistory(fixture);
  assert.equal(before.history.length, 0, "fixture jobs already have history");
  const seeded = { ...fixture, before };
  writeJson(path.join(artifactRoot, FIXTURE_NAME), seeded);
  return seeded;
}

function assertImported(fixture, state) {
  assert.equal(state.legacySchema, null, "retained cron_run_logs table was not retired");
  assert.deepEqual(state.legacyRows, []);
  assert.equal(state.history.length, fixture.entries.length, "retained cron history count changed");
  for (const entry of fixture.entries) {
    const history = state.history.find((row) => row.job_id === entry.jobId);
    assert(history, "retained cron history was lost");
    const historyId = `cron-runlog-import:${entry.jobId}:${entry.ts}:1`;
    assert.deepEqual(
      history,
      {
        history_id: historyId,
        job_id: entry.jobId,
        run_id: historyId,
        agent_id: null,
        session_key: null,
        status: entry.completionStatus,
        created_at: entry.runAtMs,
        started_at: entry.runAtMs,
        ended_at: entry.ts,
        last_event_at: entry.ts,
        cleanup_after: null,
        error: entry.error ?? null,
        summary: entry.summary,
        detail_json: history.detail_json,
      },
      "retained cron history fields changed",
    );
    assert.deepEqual(JSON.parse(history.detail_json), {
      kind: "cron-run",
      status: entry.status,
      completionStatus: entry.completionStatus,
      error: entry.error ?? null,
      summary: entry.summary,
      storeKey: fixture.storeKey,
      deliveryStatus: entry.deliveryStatus,
      runId: entry.runId,
      runAtMs: entry.runAtMs,
      durationMs: entry.durationMs,
    });
  }
  assert.equal(state.migration?.status, "completed");
  assert.deepEqual(JSON.parse(state.migration.report_json), {
    imported: 2,
    alreadyMirrored: 0,
    malformed: 0,
    skipped: false,
  });
  assertPreserved(fixture, state);
}

function assertPreserved(fixture, state) {
  for (const key of ["unrelatedHistory", "unrelatedMigration", "cronReceipt"]) {
    assert.deepEqual(state[key], fixture.before[key], `retained ${key} changed`);
  }
}

function assertCandidateState(fixture, state) {
  assert.equal(state.contentVersion, fixture.candidate.stateSchemaVersion);
  assert.equal(
    state.metadataVersion,
    state.stateSchemaVersion,
    "published schema markers disagree",
  );
  const deferred =
    fixture.baseline.version === "2026.9.2" &&
    state.stateSchemaVersion === fixture.baseline.stateSchemaVersion;
  assert(
    deferred || state.stateSchemaVersion === state.contentVersion,
    "candidate did not publish its schema or retain the old driver's floor",
  );
  if (fixture.candidate.stateSchemaVersion >= 19) {
    assert.deepEqual(state.retiredObjects, [], "retired Task tables or indexes remain");
  }
}

function observeUpdateProcess() {
  const fixturePath = process.env.OPENCLAW_UPGRADE_SURVIVOR_CRON_HISTORY_FIXTURE;
  const observations = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  const command = process.argv[2];
  if (!isMainThread || !fixturePath || !observations || !["doctor", "update"].includes(command)) {
    return;
  }
  const receipt = {
    role: command,
    pid: process.pid,
    parentPid: process.ppid,
    startedAtMs: Date.now(),
  };
  let fixture;
  try {
    fixture = readJson(fixturePath);
    assert.equal(
      fixture.databasePath,
      path.join(process.env.OPENCLAW_STATE_DIR, "state/openclaw.sqlite"),
    );
    let root = path.dirname(fs.realpathSync(process.argv[1]));
    for (let depth = 0; depth < 3; depth++, root = path.dirname(root)) {
      if (
        fs.existsSync(path.join(root, "package.json")) &&
        readJson(path.join(root, "package.json")).name === "openclaw"
      ) {
        receipt.identity = installedIdentity(root);
        break;
      }
    }
    receipt.updateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1";
    receipt.before = snapshotCronHistory(fixture);
  } catch (error) {
    receipt.observationError = String(error);
  }
  const file = path.join(observations, `cron-history-${command}-${process.pid}.json`);
  writeJson(file, receipt);
  process.once("exit", (exitCode) => {
    try {
      receipt.after = snapshotCronHistory(fixture);
    } catch (error) {
      receipt.observationError = String(error);
    }
    writeJson(file, { ...receipt, exitCode });
  });
}

function assertProcessReceipt(observations, witness, role, acceptedOutcome = "success") {
  const processReceipt = readJson(
    path.join(observations, "diagnostics", `process-${witness.pid}-exited.json`),
  );
  assert.equal(processReceipt.role, role);
  assert.equal(processReceipt.pid, witness.pid);
  assert.equal(processReceipt.packageVersion, witness.identity.version);
  assert.equal(processReceipt.parentPid, witness.parentPid);
  assert.equal(processReceipt.exitCode, witness.exitCode);
  assert.equal(witness.observationError, undefined);
  assert(
    witness.exitCode === 0 ||
      (role === "update" && acceptedOutcome === "recoverable" && witness.exitCode === 1),
    "observed process did not complete successfully",
  );
}

function summarizeSnapshot(state) {
  if (!state) {
    return undefined;
  }
  return {
    stateSchemaVersion: state.stateSchemaVersion,
    metadataVersion: state.metadataVersion,
    contentVersion: state.contentVersion,
    retiredObjects: state.retiredObjects,
    legacySha256: state.legacySha256,
    legacyRows: state.legacyRows.length,
    history: state.history.length,
    historySha256: hash(JSON.stringify(state.history)),
    preservedSha256: hash(
      JSON.stringify([state.unrelatedHistory, state.unrelatedMigration, state.cronReceipt]),
    ),
    migration: state.migration
      ? {
          status: state.migration.status,
          report_json: state.migration.report_json.slice(0, 160),
        }
      : null,
  };
}

export function assertCronHistory(artifactRoot, observations, acceptedOutcome = "success") {
  assert(["success", "recoverable"].includes(acceptedOutcome));
  const fixture = readJson(path.join(artifactRoot, FIXTURE_NAME));
  const proofFile = path.join(artifactRoot, "legacy-operator-cron-history-proof.json");
  const proof = {
    baseline: fixture.baseline,
    candidate: fixture.candidate,
    retainedSha256: fixture.before.legacySha256,
  };
  let receipts = [];
  let current;
  try {
    receipts = fs
      .readdirSync(observations)
      .filter((name) => /^cron-history-(?:doctor|update)-\d+\.json$/u.test(name))
      .map((name) => readJson(path.join(observations, name)))
      .toSorted((left, right) => left.startedAtMs - right.startedAtMs);
    current = snapshotCronHistory(fixture);
    const doctors = receipts.filter(
      (receipt) =>
        receipt.role === "doctor" &&
        receipt.identity?.buildInfoSha256 === fixture.candidate.buildInfoSha256 &&
        !receipt.observationError,
    );
    let updater;
    let witness;
    if (["2026.9.2", "2026.9.3"].includes(fixture.baseline.version)) {
      // These shipped updaters import through their normal opener when admitting
      // the update ledger, before candidate code runs. Its result must survive Doctor.
      updater = receipts.find(
        (receipt) =>
          receipt.role === "update" &&
          receipt.identity?.buildInfoSha256 === fixture.baseline.buildInfoSha256 &&
          receipt.before?.legacySha256 === fixture.before.legacySha256,
      );
      assert(updater, "published updater never received the unchanged retained cron history");
      assert.deepEqual(updater.identity, fixture.baseline);
      assertProcessReceipt(observations, updater, "update", acceptedOutcome);
      assert.equal(updater.before.stateSchemaVersion, fixture.before.stateSchemaVersion);
      assert.deepEqual(updater.before.legacyRows, fixture.before.legacyRows);
      assert.deepEqual(updater.before.history, []);
      assertPreserved(fixture, updater.before);
      // 9.2 first rehearses privately; only a live, settled candidate Doctor can qualify.
      witness = doctors.find(
        (doctor) => doctor.after?.contentVersion === fixture.candidate.stateSchemaVersion,
      );
      assert(witness, "candidate Doctor was not observed against the live database");
      assertImported(fixture, witness.before);
      assert.deepEqual(
        witness.after.history,
        witness.before.history,
        "cron history bytes changed in Doctor",
      );
      assert.deepEqual(
        witness.after.migration,
        witness.before.migration,
        "import receipt changed in Doctor",
      );
    } else {
      witness = doctors.find(
        (receipt) => receipt.before?.legacySha256 === fixture.before.legacySha256,
      );
      assert(witness, "candidate Doctor never received the unchanged retained cron history");
      assert.equal(witness.before.stateSchemaVersion, fixture.before.stateSchemaVersion);
      assert.deepEqual(witness.before.legacyRows, fixture.before.legacyRows);
      assert.deepEqual(witness.before.history, []);
      assertPreserved(fixture, witness.before);
    }
    assert.deepEqual(witness.identity, fixture.candidate);
    assert.equal(witness.updateInProgress, true, "Doctor was not an updater child");
    assertProcessReceipt(observations, witness, "doctor");
    assertImported(fixture, witness.after);
    assertImported(fixture, current);
    assertCandidateState(fixture, witness.after);
    assertCandidateState(fixture, current);
    assert.deepEqual(
      current.history,
      witness.after.history,
      "cron history bytes changed after Doctor",
    );
    assert.deepEqual(
      current.migration,
      witness.after.migration,
      "import receipt changed after Doctor",
    );
    writeJson(proofFile, {
      ...proof,
      status: "passed",
      contract: updater ? "published-updater-import-preserved" : "candidate-doctor-import",
      currentSchemaAtDoctorEntry:
        witness.before.contentVersion === fixture.candidate.stateSchemaVersion,
      ...(updater
        ? {
            updater: {
              pid: updater.pid,
              parentPid: updater.parentPid,
              identity: updater.identity,
              before: summarizeSnapshot(updater.before),
            },
          }
        : {}),
      // Full process observations stay local; the published proof has a 16 KiB budget.
      doctor: {
        ...witness,
        before: summarizeSnapshot(witness.before),
        after: summarizeSnapshot(witness.after),
      },
    });
  } catch (error) {
    writeJson(proofFile, {
      ...proof,
      status: "failed",
      failure: String(error).slice(0, 500),
      current: summarizeSnapshot(current),
      observationCount: receipts.length,
      // This file shares the existing 16 KiB diagnostic publication budget.
      observations: receipts.slice(0, 8).map((receipt) => ({
        role: receipt.role,
        pid: receipt.pid,
        parentPid: receipt.parentPid,
        startedAtMs: receipt.startedAtMs,
        // Known package identities are pinned above; full observations remain private.
        identitySha256: hash(JSON.stringify(receipt.identity ?? null)),
        exitCode: receipt.exitCode,
        observationError: receipt.observationError?.slice(0, 160),
        before: summarizeSnapshot(receipt.before),
        after: summarizeSnapshot(receipt.after),
      })),
    });
    throw error;
  }
}

observeUpdateProcess();

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "seed") {
    seedCronHistory(
      process.env.OPENCLAW_STATE_DIR,
      process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT,
      ...args,
    );
  } else {
    assert.equal(command, "assert");
    assertCronHistory(process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT, args[0], args[1]);
  }
}
