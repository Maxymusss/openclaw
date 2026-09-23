import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import {
  assertCronHistory,
  seedCronHistory,
  snapshotCronHistory,
} from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-cron-history.mjs";
import { migrateLegacyCronRunLogsToHistory } from "../../src/infra/state-migrations.cron-run-logs.js";
import { migrateTasksRetirementV19 } from "../../src/state/openclaw-state-db-schema-v19-task-retirement.js";
import { RETIRED_TASK_SCHEMA_SQL } from "../../src/state/openclaw-state-db-schema-v19-task-source.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/e2e/lib/upgrade-survivor/legacy-operator-cron-history.mjs");
const diagnostics = path.resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs");

// A fixed fixture of the published importer, not another product migration owner.
// The installed-driver survivor cell separately proves the real published implementation.
const oldImport = `
  for (const row of db.prepare('SELECT * FROM cron_run_logs ORDER BY job_id').all()) {
    const entry = JSON.parse(row.entry_json);
    const id = 'cron-runlog-import:' + entry.jobId + ':' + entry.ts + ':1';
    db.prepare(
      'INSERT INTO task_runs (task_id, runtime, source_id, run_id, owner_key, scope_kind, task, status, ' +
      'delivery_status, notify_policy, created_at, started_at, ended_at, last_event_at, error, terminal_summary, detail_json) ' +
      "VALUES (?, 'cron', ?, ?, '', 'system', ?, ?, 'not_applicable', 'silent', ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, entry.jobId, id, entry.jobId, entry.completionStatus, entry.runAtMs, entry.runAtMs,
      entry.ts, entry.ts, entry.error ?? null, entry.summary, JSON.stringify({
        kind: 'cron-run', status: entry.status, completionStatus: entry.completionStatus,
        error: entry.error ?? null, summary: entry.summary, storeKey: row.store_key,
        deliveryStatus: entry.deliveryStatus, runId: entry.runId, runAtMs: entry.runAtMs, durationMs: entry.durationMs,
      }));
  }
  db.exec('DROP TABLE cron_run_logs');
  db.prepare("INSERT INTO migration_runs VALUES (?, 100, 101, 'completed', ?)").run(
    'state:cron-run-logs-to-task-runs:v1',
    JSON.stringify({ imported: 2, alreadyMirrored: 0, malformed: 0, skipped: false }));
`;

function prepare(version = "2026.9.4", targetSchema = 19) {
  const root = tempDirs.make("survivor-cron-history-");
  const stateDir = path.join(root, "state");
  const artifacts = path.join(root, "artifacts");
  const observations = path.join(artifacts, "observation");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "package");
  mkdirSync(path.join(stateDir, "state"), { recursive: true });
  mkdirSync(observations, { recursive: true });
  const schema = version === "2026.9.4" ? 17 : version === "2026.9.3" ? 16 : 15;
  for (const [directory, packageVersion, stateSchema] of [
    [baseline, version, schema],
    [candidate, "2026.9.5", targetSchema],
  ] as const) {
    mkdirSync(path.join(directory, "dist"), { recursive: true });
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: packageVersion,
        type: "module",
        openclaw: { schemaVersions: { state: stateSchema } },
      }),
    );
    writeFileSync(
      path.join(directory, "dist/build-info.json"),
      JSON.stringify({ fixture: directory }),
    );
  }
  const databasePath = path.join(stateDir, "state/openclaw.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  db.exec("DROP TABLE cron_run_history");
  db.exec(RETIRED_TASK_SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${schema}`);
  db.prepare(`INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
    VALUES ('primary', 'global', ?, 1, 1)`).run(schema);
  db.close();
  writeFileSync(
    path.join(artifacts, "legacy-operator-baseline.json"),
    JSON.stringify({
      jobs: [{ id: "retained-main" }, { id: "retained-ops" }],
    }),
  );
  const tarball = path.join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  const seeded = seedCronHistory(stateDir, artifacts, baseline, tarball);
  const entry = path.join(candidate, "openclaw.mjs");
  // This process qualifies the observer, not an installed Doctor. The real
  // published updater cell must exercise Doctor's admission and full ordering.
  writeFileSync(
    entry,
    `
    import { DatabaseSync } from 'node:sqlite';
    import { migrateLegacyCronRunLogsToHistory } from ${JSON.stringify(pathToFileURL(path.resolve("src/infra/state-migrations.cron-run-logs.ts")).href)};
    import { migrateTasksRetirementV19 } from ${JSON.stringify(pathToFileURL(path.resolve("src/state/openclaw-state-db-schema-v19-task-retirement.ts")).href)};
    if (process.env.FIXTURE_REHEARSAL === '1') process.exit(0);
    const db = new DatabaseSync(${JSON.stringify(databasePath)});
    db.exec('BEGIN IMMEDIATE');
    ${targetSchema >= 19 ? "migrateTasksRetirementV19(db, db.prepare('PRAGMA user_version').get().user_version);" : ""}
    if (process.env.FIXTURE_IMPORT === '1') {
      ${targetSchema >= 19 ? "migrateLegacyCronRunLogsToHistory(db);" : oldImport}
    }
    db.exec('PRAGMA user_version = ${version === "2026.9.2" ? 15 : targetSchema}; UPDATE schema_meta SET schema_version = ${version === "2026.9.2" ? 15 : targetSchema};');
    ${version === "2026.9.2" ? `db.exec("INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${targetSchema}', 1)");` : ""}
    db.exec('COMMIT');
    db.close();
  `,
  );
  const preloads = [
    "--import",
    path.resolve("scripts/tsx.mjs"),
    "--import",
    diagnostics,
    "--import",
    helper,
  ];
  const updater = path.join(baseline, "openclaw.mjs");
  writeFileSync(
    updater,
    `
    import { execFileSync } from 'node:child_process';
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(databasePath)});
    db.exec('BEGIN IMMEDIATE');
    ${oldImport}
    if (process.env.FIXTURE_AFTER_IMPORT_SQL) {
      db.exec(process.env.FIXTURE_AFTER_IMPORT_SQL);
    }
    db.exec('COMMIT');
    db.close();
    ${
      version === "2026.9.2"
        ? `execFileSync(process.execPath, ${JSON.stringify([...preloads, entry, "doctor", "--fix", "--non-interactive"])}, {
      env: { ...process.env, FIXTURE_REHEARSAL: '1', OPENCLAW_UPDATE_IN_PROGRESS: '1' }, stdio: 'inherit',
    });`
        : ""
    }
    execFileSync(process.execPath, ${JSON.stringify([...preloads, entry, "doctor", "--fix", "--non-interactive"])}, {
      env: { ...process.env, FIXTURE_IMPORT: '0', OPENCLAW_UPDATE_IN_PROGRESS: '1' },
      stdio: 'inherit',
    });
  `,
  );
  const invokeProcess = (
    file: string,
    command: string,
    importHistory: boolean,
    afterImportSql?: string,
  ) =>
    spawnSync(
      process.execPath,
      [
        ...preloads,
        file,
        command,
        ...(command === "doctor" ? ["--fix", "--non-interactive"] : ["--yes", "--no-restart"]),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: observations,
          OPENCLAW_UPGRADE_SURVIVOR_CRON_HISTORY_FIXTURE: path.join(
            artifacts,
            "legacy-operator-cron-history.json",
          ),
          FIXTURE_IMPORT: importHistory ? "1" : "0",
          FIXTURE_AFTER_IMPORT_SQL: afterImportSql,
        },
      },
    );
  return {
    artifacts,
    observations,
    databasePath,
    stateDir,
    seeded,
    targetSchema,
    invoke: (importHistory: boolean) => invokeProcess(entry, "doctor", importHistory),
    invokeUpdater: (afterImportSql?: string) =>
      invokeProcess(updater, "update", false, afterImportSql),
  };
}

it.each([
  ["2026.9.2", 19],
  ["2026.9.3", 19],
  ["2026.9.4", 19],
  ["2026.9.3", 17],
  ["2026.9.4", 17],
] as const)(
  "proves %s retained-history ownership through the updater and Doctor to schema %s",
  (version, targetSchema) => {
    const fixture = prepare(version, targetSchema);
    const importsBeforeDoctor = version !== "2026.9.4";
    const beforeBytes = readFileSync(fixture.databasePath);
    const beforeFiles = readdirSync(path.dirname(fixture.databasePath));
    expect(snapshotCronHistory(fixture.seeded)).toEqual(fixture.seeded.before);
    expect(readFileSync(fixture.databasePath)).toEqual(beforeBytes);
    expect(readdirSync(path.dirname(fixture.databasePath))).toEqual(beforeFiles);
    const result = importsBeforeDoctor ? fixture.invokeUpdater() : fixture.invoke(true);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    assertCronHistory(fixture.artifacts, fixture.observations);
    const evidence = JSON.parse(
      readFileSync(path.join(fixture.artifacts, "legacy-operator-cron-history-proof.json"), "utf8"),
    );
    expect(evidence.currentSchemaAtDoctorEntry).toBe(version === "2026.9.4" && targetSchema === 17);
    expect(evidence.contract).toBe(
      importsBeforeDoctor ? "published-updater-import-preserved" : "candidate-doctor-import",
    );
    expect(evidence.doctor.before.legacyRows).toBe(importsBeforeDoctor ? 0 : 2);
    expect(evidence.doctor.after.history).toBe(2);
    expect(evidence.doctor.after.contentVersion).toBe(targetSchema);
    expect(evidence.doctor.after.stateSchemaVersion).toBe(
      version === "2026.9.2" ? 15 : targetSchema,
    );
    expect(evidence.doctor.after.metadataVersion).toBe(evidence.doctor.after.stateSchemaVersion);
    if (targetSchema >= 19) {
      expect(evidence.doctor.after.retiredObjects).toEqual([]);
    }
    expect(Buffer.byteLength(JSON.stringify(evidence, null, 2))).toBeLessThan(16 * 1024);
    if (importsBeforeDoctor) {
      expect(evidence.updater.before.legacyRows).toBe(2);
      expect(evidence.updater.before.history).toBe(0);
      expect(evidence.updater.identity).toEqual(evidence.baseline);
      expect(evidence.doctor.before.historySha256).toBe(evidence.doctor.after.historySha256);
      writeFileSync(
        path.join(fixture.artifacts, "summary.json"),
        JSON.stringify({
          status: "passed",
          baseline: { spec: `openclaw@${version}`, version },
          candidate: { kind: "tarball", version: "2026.9.5" },
          scenario: "legacy-operator-state",
          installedVersion: "2026.9.5",
          candidateInstallMode: "updater",
          updateRestartMode: "manual",
          updateOutcome: "success",
          phases: [],
        }),
      );
      const published = path.join(fixture.artifacts, "published");
      publishDiagnostics(fixture.artifacts, published, (text: string) => text, "passed");
      const summary = JSON.parse(readFileSync(path.join(published, "summary.json"), "utf8"));
      expect(JSON.parse(summary.logs["legacy-operator-cron-history-proof.json"])).toEqual(evidence);
    }
  },
);

it("rejects a successful Doctor exit which leaves retained history for startup", () => {
  const fixture = prepare();
  const result = fixture.invoke(false);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(() => assertCronHistory(fixture.artifacts, fixture.observations)).toThrow(
    "table was not retired",
  );
});

it("rejects parent-side import even when canonical history and Doctor exit are correct", () => {
  const fixture = prepare();
  const db = new DatabaseSync(fixture.databasePath);
  db.exec("BEGIN IMMEDIATE");
  migrateTasksRetirementV19(db, 17);
  migrateLegacyCronRunLogsToHistory(db);
  db.exec("PRAGMA user_version = 19; UPDATE schema_meta SET schema_version = 19; COMMIT");
  db.close();
  const result = fixture.invoke(false);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const receiptName = readdirSync(fixture.observations).find((name) =>
    name.startsWith("cron-history-doctor-"),
  );
  expect(receiptName).toBeDefined();
  const receipt = JSON.parse(readFileSync(path.join(fixture.observations, receiptName!), "utf8"));
  for (let index = 1; index < 8; index++) {
    writeFileSync(
      path.join(fixture.observations, `cron-history-doctor-${receipt.pid + index}.json`),
      JSON.stringify({
        ...receipt,
        pid: receipt.pid + index,
        startedAtMs: receipt.startedAtMs + index,
        observationError: "rejected rehearsal observation ".repeat(40),
      }),
    );
  }
  expect(() => assertCronHistory(fixture.artifacts, fixture.observations)).toThrow(
    "never received the unchanged retained cron history",
  );
  const evidence = JSON.parse(
    readFileSync(path.join(fixture.artifacts, "legacy-operator-cron-history-proof.json"), "utf8"),
  );
  expect(evidence.status).toBe("failed");
  expect(evidence.observations).toHaveLength(8);
  expect(evidence.observations[0].identitySha256).toBe(
    createHash("sha256").update(JSON.stringify(receipt.identity)).digest("hex"),
  );
  expect(Buffer.byteLength(JSON.stringify(evidence, null, 2))).toBeLessThan(16 * 1024);
  expect(evidence.observations[0]).toMatchObject({
    role: "doctor",
    exitCode: 0,
    before: { legacyRows: 0, history: 2 },
    after: { legacyRows: 0, history: 2 },
  });
  const captured = spawnSync(
    process.execPath,
    [diagnostics, "capture", fixture.artifacts, "assert-retained-cron-doctor", "1"],
    { encoding: "utf8", env: { ...process.env, OPENCLAW_STATE_DIR: fixture.stateDir } },
  );
  expect(captured.status, captured.stderr).toBe(0);
  const published = path.join(fixture.artifacts, "published");
  publishDiagnostics(fixture.artifacts, published, (text: string) => text);
  const failure = JSON.parse(readFileSync(path.join(published, "failure.json"), "utf8"));
  expect(JSON.parse(failure.logs["legacy-operator-cron-history-proof.json"])).toEqual(evidence);
});

it.each(["2026.9.2", "2026.9.3"])(
  "requires the original seed at the published %s updater entry",
  (version) => {
    const fixture = prepare(version);
    const result = fixture.invoke(true);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(() => assertCronHistory(fixture.artifacts, fixture.observations)).toThrow(
      "published updater never received the unchanged retained cron history",
    );
  },
);

it.each([
  [
    "history count",
    "DELETE FROM task_runs WHERE source_id = 'retained-ops'",
    "history count changed",
  ],
  [
    "task content",
    "UPDATE task_runs SET terminal_summary = 'changed' WHERE source_id = 'retained-main'",
    "retained cron history fields changed",
  ],
  [
    "import report",
    `UPDATE migration_runs SET report_json = '{"imported":1,"alreadyMirrored":0,"malformed":0,"skipped":false}' WHERE id = 'state:cron-run-logs-to-task-runs:v1'`,
    "Expected values to be strictly deep-equal",
  ],
])("rejects damaged %s from the 9.3 updater before Doctor", (_, sql, message) => {
  const fixture = prepare("2026.9.3");
  const result = fixture.invokeUpdater(sql);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(() => assertCronHistory(fixture.artifacts, fixture.observations)).toThrow(message);
});
