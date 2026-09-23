import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../commands/doctor.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { restorePreV19StateSchemaForTest } from "../state/openclaw-state-schema-v19.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { mocks } from "./doctor-health.test-support.js";

// Keep the real Doctor config/migration chain; the shared harness isolates service and UI checks.
vi.doUnmock("../commands/doctor-config-flow.js");
vi.doUnmock("../commands/doctor-prompter.js");
vi.doUnmock("../commands/doctor/shared/plugin-runtime-symlinks.js");

beforeEach(() => {
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.outro.mockClear();
  mocks.runContributions.mockReset();
});
afterEach(() => vi.restoreAllMocks());

async function seedState(state: OpenClawTestState) {
  await state.writeConfig({
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    gateway: { mode: "local" },
    plugins: { enabled: false },
  });
  const database = openOpenClawStateDatabase({ env: state.env });
  database.db.exec(`
    INSERT INTO skill_workshop_collection_reviews (
      review_id, owner_agent_id, backup_id, create_time, kept_names_json, written_names_json, dropped_json
    ) VALUES ('review-preserved', 'main', 'backup-preserved', 1, '[]', '[]', '[]');
  `);
  return database;
}

function damageWorkshopIndex(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      "CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
    );
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
                         ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)'
          WHERE type = 'index' AND name = 'idx_skill_workshop_collection_reviews_workspace_time'`,
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

describe("Doctor malformed Workshop catalog recovery", () => {
  it("restores readability before the real config and v19 migration chain", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = await seedState(state);
      restorePreV19StateSchemaForTest(database.db);
      database.db.exec(`
        DROP INDEX idx_audit_events_time;
        PRAGMA foreign_keys = OFF;
        INSERT INTO task_delivery_state (task_id, requester_origin_json)
          VALUES ('orphan-retired', 'legacy delivery is retired');
        INSERT INTO task_runs (
          task_id, runtime, owner_key, scope_kind, task, status, delivery_status, notify_policy,
          created_at, source_id, terminal_summary, detail_json
        ) VALUES ('cron-retained', 'cron', 'global', 'global', 'retained history', 'succeeded',
          'delivered', 'silent', 1, 'deleted-job', 'summary preserved', ' { "unknown": true } ');
        PRAGMA foreign_keys = ON;
      `);
      await closeOpenClawStateDatabaseAsync();
      damageWorkshopIndex(database.path);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await doctorCommand(runtime, { repair: true, nonInteractive: true });

      expect(runtime.exit).not.toHaveBeenCalled();
      expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
      expect(runtime.log).toHaveBeenCalledWith(
        "Removed dangling legacy Skill Workshop review index",
      );
      const { DatabaseSync } = requireNodeSqlite();
      const repaired = new DatabaseSync(database.path, { readOnly: true });
      try {
        expect(
          repaired
            .prepare("SELECT review_id, backup_id FROM skill_workshop_collection_reviews")
            .all(),
        ).toEqual([{ review_id: "review-preserved", backup_id: "backup-preserved" }]);
        expect(
          repaired
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name = 'idx_skill_workshop_collection_reviews_workspace_time'",
            )
            .get(),
        ).toBeUndefined();
        expect(
          repaired.prepare("SELECT name FROM pragma_index_info('idx_audit_events_time')").all(),
        ).toEqual([{ name: "occurred_at" }, { name: "sequence" }]);
        expect(
          repaired
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name IN ('task_runs', 'task_delivery_state', 'flow_runs')",
            )
            .all(),
        ).toEqual([]);
        expect(
          repaired
            .prepare("SELECT history_id, job_id, summary, detail_json FROM cron_run_history")
            .all(),
        ).toEqual([
          {
            history_id: "cron-retained",
            job_id: "deleted-job",
            summary: "summary preserved",
            detail_json: ' { "unknown": true } ',
          },
        ]);
        expect(
          repaired
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get(),
        ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
        expect(readSqliteNumberPragma(repaired, "user_version")).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
        expect(repaired.prepare("PRAGMA integrity_check").all()).toEqual([
          { integrity_check: "ok" },
        ]);
        expect(repaired.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        const recoveryDirs = fs
          .readdirSync(path.dirname(database.path))
          .filter((name) => name.startsWith("openclaw-task-delivery-recovery-"));
        // v19 retires these legacy rows in the schema transaction; it must not
        // revive the removed Doctor export-and-repair path.
        expect(recoveryDirs).toEqual([]);
      } finally {
        repaired.close();
      }
    });
  });

  it.each(["shared-schema", "custom-agent-schema", "external-owner"] as const)(
    "refuses %s before changing the malformed source",
    async (reason) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const database = await seedState(state);
        if (reason === "shared-schema") {
          database.db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
        } else if (reason === "custom-agent-schema") {
          const customPath = state.path("custom", "sessions.sqlite");
          fs.mkdirSync(path.dirname(customPath));
          const { DatabaseSync } = requireNodeSqlite();
          const custom = new DatabaseSync(customPath);
          custom.exec(`
            PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};
            CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, agent_id TEXT);
            INSERT INTO schema_meta VALUES ('primary', 'main');
          `);
          custom.close();
          await state.writeConfig({
            agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
            session: { store: customPath },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
        } else {
          claimOpenClawStateOwnership("fixture-manager", {
            env: { ...state.env, OPENCLAW_SUPERVISOR_MODE: "external" },
          });
        }
        await closeOpenClawStateDatabaseAsync();
        damageWorkshopIndex(database.path);
        const before = fs.readFileSync(database.path);
        const configBefore = fs.readFileSync(state.configPath);

        await expect(
          doctorCommand(
            { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            { repair: true, nonInteractive: true },
          ),
        ).rejects.toThrow(reason === "external-owner" ? /externally supervised/ : /newer/);

        expect(fs.readFileSync(database.path)).toEqual(before);
        expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
        expect(mocks.runContributions).not.toHaveBeenCalled();
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
      });
    },
  );
});
