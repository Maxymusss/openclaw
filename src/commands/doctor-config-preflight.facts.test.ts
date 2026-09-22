import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readConfigFileSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { retainSnapshotTempDirectory } from "../infra/sqlite-readonly-location-cleanup.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { DoctorAgentSchemaFacts } from "../state/doctor-agent-schema-facts.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION as version } from "../state/openclaw-agent-db-contract.js";
import type { AgentDatabasePreflightStats } from "../state/openclaw-database-preflight-agent-scheduler.js";
import * as preflight from "../state/openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readStartupMigrationSnapshot } from "./doctor-config-preflight-startup.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";

afterEach(() => vi.restoreAllMocks());

function seed(pathname: string, agentId: string, schemaVersion = version) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const db = new DatabaseSync(pathname);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT, app_version TEXT);
      PRAGMA user_version=${schemaVersion};`);
    db.prepare("INSERT INTO schema_meta VALUES ('primary', 'agent', ?, ?, 'fixture')").run(
      schemaVersion,
      agentId,
    );
  } finally {
    db.close();
  }
  expect(fs.existsSync(`${pathname}-wal`)).toBe(false);
  return pathname;
}
function mutate(pathname: string, sql: string) {
  const db = new DatabaseSync(pathname);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

async function withFleet(
  run: (fleet: {
    home: string;
    stateDir: string;
    configPath: string;
    paths: string[];
    config: OpenClawConfig;
    copies: string[];
    stats: AgentDatabasePreflightStats[];
    writeConfig: (config: OpenClawConfig) => void;
    admit: (
      facts: DoctorAgentSchemaFacts,
      guard?: () => Promise<boolean>,
    ) => ReturnType<typeof readStartupMigrationSnapshot>;
    inspect: (
      facts?: DoctorAgentSchemaFacts,
      cfg?: OpenClawConfig,
    ) => ReturnType<typeof prepareDoctorDatabasePreflight>;
  }) => Promise<void>,
) {
  const previousOptions = process.env.NODE_OPTIONS;
  const previousHandoff = process.env.OPENCLAW_TEST_DOCTOR_HANDOFF_DIR;
  let fixtureHome: string | undefined;
  try {
    await withDoctorConfigPreflightHome(async (home) => {
      fixtureHome = home;
      const control = fs.realpathSync(path.join(home, "update-control"));
      await withEnvAsync(
        {
          NODE_OPTIONS: `--import=${new URL("./doctor-config-preflight.facts.preload.mjs", import.meta.url).href}`,
          OPENCLAW_TEST_DOCTOR_HANDOFF_DIR: control,
        },
        async () => {
          const handoff = resolveManagedUpdateLeaseDatabasePath();
          expect(fs.realpathSync(path.dirname(handoff))).toBe(
            path.join(fs.realpathSync(home), "update-control"),
          );
          const stateDir = path.join(home, ".openclaw");
          const configPath = path.join(stateDir, "openclaw.json");
          const paths = ["main", "second"].map((id) =>
            seed(path.join(stateDir, "agents", id, "agent", "openclaw-agent.sqlite"), id),
          );
          const config: OpenClawConfig = {
            gateway: { mode: "local" },
            plugins: { enabled: false },
            agents: { entries: { main: { default: true }, second: {} } },
          };
          const writeConfig = (cfg: OpenClawConfig) =>
            fs.writeFileSync(configPath, JSON.stringify(cfg));
          writeConfig(config);
          const copies: string[] = [];
          const stats: AgentDatabasePreflightStats[] = [];
          const prepare = snapshots.prepareSqliteReadOnlyLocation;
          vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
            async (...args) => {
              const prepared = await prepare(...args);
              copies.push(args[0]);
              return prepared;
            },
          );
          const inspect = preflight.preflightOpenClawDatabaseSchemas;
          vi.spyOn(preflight, "preflightOpenClawDatabaseSchemas").mockImplementation((options) =>
            inspect({
              ...options,
              onAgentInspection: (value) => {
                stats.push(value);
                options.onAgentInspection?.(value);
              },
            }),
          );
          try {
            await withSqliteReadOnlyWorkerScope(() =>
              run({
                home,
                stateDir,
                configPath,
                paths,
                config,
                copies,
                stats,
                writeConfig,
                admit: (facts, guard) =>
                  readStartupMigrationSnapshot({
                    env: process.env,
                    doctorAgentSchemaFacts: facts,
                    readSnapshot: async () => ({
                      snapshot: await readConfigFileSnapshot({
                        observe: false,
                        pluginValidation: "core-only",
                      }),
                      pluginMigrationFingerprint: null,
                    }),
                    planRepair: () => null,
                    beforeStateMigrations: guard,
                  }),
                inspect: (facts, cfg = config) =>
                  prepareDoctorDatabasePreflight({ cfg, doctorAgentSchemaFacts: facts }),
              }),
            );
          } finally {
            await closeOpenClawStateDatabaseAsync();
            expect(fs.existsSync(path.join(control, "blocked-native-opens.jsonl"))).toBe(false);
            const readbacks: {
              pid: number;
              argv: string[];
              resolved: string;
              canonicalParent: string;
              handoffModule: string;
            }[] = fs
              .readFileSync(path.join(control, "helper-resolvers.jsonl"), "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            expect(readbacks.length).toBeGreaterThan(0);
            expect(readbacks.length).toBeGreaterThanOrEqual(
              stats.reduce((count, stat) => count + stat.schemaProcessCount, 0),
            );
            for (const readback of readbacks) {
              expect(readback.resolved).toBe(path.join(control, "managed-update-handoffs.sqlite"));
              expect(readback.canonicalParent).toBe(control);
              const entry = readback.argv[1];
              const marker = `${path.sep}dist${path.sep}`;
              if (entry?.includes(marker)) {
                const dist = entry.slice(0, entry.indexOf(marker) + marker.length);
                expect(readback.handoffModule).toBe(
                  path.join(dist, "infra", "update-managed-service-handoff-lease.js"),
                );
              }
              let exitError: unknown;
              try {
                process.kill(readback.pid, 0);
              } catch (error) {
                exitError = error;
              }
              expect(exitError, `native helper ${readback.pid} must be joined`).toMatchObject({
                code: "ESRCH",
              });
            }
          }
        },
      );
    });
  } finally {
    expect(process.env.NODE_OPTIONS).toBe(previousOptions);
    expect(process.env.OPENCLAW_TEST_DOCTOR_HANDOFF_DIR).toBe(previousHandoff);
    if (fixtureHome) {
      expect(fs.existsSync(fixtureHome)).toBe(false);
    }
  }
}

it("hands unchanged owned headers from initial admission to the actual lease-held refresh", async () => {
  await withFleet(async (fleet) => {
    // A terminal first run must not lend headers to the next invocation.
    for (let attempt = 0; attempt < 2; attempt++) {
      const waves: number[] = [];
      fleet.copies.length = 0;
      await expect(
        runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          observe: false,
          requireStartupMigrationCheckpoint: true,
          beforeStateMigrations: async () => {
            waves.push(fleet.copies.filter((p) => fleet.paths.includes(p)).length);
            fleet.copies.length = 0;
            if (waves.length === 2) {
              expect(hasActiveStartupMigrationLease()).toBe(true);
              throw new Error("end of lease-refresh fixture");
            }
            return true;
          },
        }),
      ).rejects.toThrow("end of lease-refresh fixture");
      expect(waves).toEqual([2, 0]);
      expect(hasActiveStartupMigrationLease()).toBe(false);
    }
  });
});

it("freshly inspects owned rollback-mode agents on both admissions", async () => {
  await withFleet(async (fleet) => {
    for (const pathname of fleet.paths) {
      const db = new DatabaseSync(pathname);
      try {
        expect(db.prepare("PRAGMA journal_mode=DELETE").get()).toMatchObject({
          journal_mode: "delete",
        });
      } finally {
        db.close();
      }
    }
    const facts = new DoctorAgentSchemaFacts();
    try {
      await fleet.admit(facts);
      expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(2);
      facts.beginRefresh();
      expect(await fleet.inspect(facts)).toMatchObject({ incompatible: [], indeterminate: [] });
      expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(2);
    } finally {
      facts.discard();
    }
  });
});

it("rereads config and inspects a newly configured target under the actual lease", async () => {
  await withFleet(async (fleet) => {
    let guards = 0;
    const next = path.join(fleet.home, "custom", "openclaw-agent.sqlite");
    await expect(
      runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        requireStartupMigrationCheckpoint: true,
        beforeStateMigrations: async (snapshot) => {
          if (++guards === 1) {
            seed(next, "third");
            fleet.writeConfig({
              ...fleet.config,
              agents: {
                entries: {
                  ...fleet.config.agents?.entries,
                  third: { agentDir: path.dirname(next) },
                },
              },
            });
            fleet.copies.length = 0;
            return true;
          }
          expect(snapshot?.config.agents?.entries).toHaveProperty("third");
          expect(fleet.copies.filter((p) => p === next)).toHaveLength(1);
          expect(fleet.copies.filter((p) => fleet.paths.includes(p))).toEqual([]);
          throw new Error("changed config observed under lease");
        },
      }),
    ).rejects.toThrow("changed config observed under lease");
    expect(guards).toBe(2);
    expect(hasActiveStartupMigrationLease()).toBe(false);
  });
});

it("refuses an ownership-only WAL commit even when the main file bytes do not change", async () => {
  await withFleet(async (fleet) => {
    const facts = new DoctorAgentSchemaFacts();
    await fleet.admit(facts);
    const source = fleet.paths[0]!;
    const before = fs.readFileSync(source);
    const writer = new DatabaseSync(source);
    try {
      writer.exec("PRAGMA wal_autocheckpoint=0; UPDATE schema_meta SET agent_id='foreign';");
      expect(
        execFileSync(
          process.execPath,
          ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", source],
          { env: process.env },
        ),
      ).toEqual(before);
      facts.beginRefresh();
      const result = await fleet.inspect(facts);
      expect(result.agentRefusals).toEqual([
        expect.objectContaining({
          agentId: "main",
          embeddedOwnerId: "foreign",
          code: "agent-database-ownership-mismatch",
        }),
      ]);
      expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(1);
    } finally {
      writer.close();
      facts.discard();
    }
  });
});

it.each(["same bytes", "newer schema", "symlink retarget"] as const)(
  "misses a same-path replacement: %s",
  async (change) => {
    await withFleet(async (fleet) => {
      const facts = new DoctorAgentSchemaFacts();
      await fleet.admit(facts);
      const source = fleet.paths[0]!;
      const replacement = path.join(fleet.home, "replacement.sqlite");
      fs.copyFileSync(source, replacement);
      if (change === "newer schema") {
        mutate(replacement, `PRAGMA user_version=${version + 1};`);
      }
      if (change === "symlink retarget") {
        fs.unlinkSync(source);
        fs.symlinkSync(replacement, source);
      } else {
        fs.renameSync(replacement, source);
      }
      facts.beginRefresh();
      if (change === "newer schema") {
        await expect(fleet.inspect(facts)).rejects.toMatchObject({
          incompatibleDatabases: [
            expect.objectContaining({
              path: source,
              foundVersion: version + 1,
              supportedVersion: version,
            }),
          ],
        });
      } else {
        expect(await fleet.inspect(facts)).toMatchObject({ incompatible: [], indeterminate: [] });
      }
      expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(1);
      facts.discard();
    });
  },
);

it("re-evaluates a different requested agent for the same source", async () => {
  await withFleet(async (fleet) => {
    const facts = new DoctorAgentSchemaFacts();
    await fleet.admit(facts);
    facts.beginRefresh();
    const result = await fleet.inspect(facts, {
      ...fleet.config,
      agents: {
        entries: {
          main: { default: true },
          reassigned: { agentDir: path.dirname(fleet.paths[1]!) },
        },
      },
    });
    expect(result.agentRefusals).toContainEqual(
      expect.objectContaining({ agentId: "reassigned", embeddedOwnerId: "second" }),
    );
    expect(fleet.stats.at(-1)!.schemaInspectionCount).toBeGreaterThan(0);
    facts.discard();
  });
});

it.each(["missing", "null", "foreign", "old", "metadata version"] as const)(
  "keeps %s ownership/schema on the fresh path",
  async (change) => {
    await withFleet(async (fleet) => {
      const source = fleet.paths[0]!;
      const sql = {
        missing: "DELETE FROM schema_meta;",
        null: "UPDATE schema_meta SET agent_id=NULL;",
        foreign: "UPDATE schema_meta SET agent_id='foreign';",
        old: `PRAGMA user_version=${version - 1}; UPDATE schema_meta SET schema_version=${version - 1};`,
        "metadata version": `UPDATE schema_meta SET schema_version=${version - 1};`,
      }[change];
      mutate(source, sql);
      const facts = new DoctorAgentSchemaFacts();
      await fleet.admit(facts);
      facts.beginRefresh();
      const result = await fleet.inspect(facts);
      expect(fleet.stats.at(-1)!.schemaInspectionCount).toBeGreaterThan(0);
      if (change === "foreign") {
        expect(result.agentRefusals).toContainEqual(
          expect.objectContaining({ embeddedOwnerId: "foreign" }),
        );
      }
      if (change === "old") {
        expect(result.pendingMigrations).toContainEqual(
          expect.objectContaining({ path: source, foundVersion: version - 1 }),
        );
      }
      facts.discard();
    });
  },
);

it("refreshes registry additions and removals without resurrecting removed targets", async () => {
  await withFleet(async (fleet) => {
    const extra = seed(path.join(fleet.home, "external", "extra.sqlite"), "registry");
    const replacement = seed(path.join(fleet.home, "external", "new.sqlite"), "new", version + 1);
    const shared = openOpenClawStateDatabase({ env: process.env }).path;
    await closeOpenClawStateDatabaseAsync();
    const register = (pathname: string, agentId: string) => {
      const db = new DatabaseSync(shared);
      try {
        db.prepare(
          "INSERT INTO agent_databases(agent_id,path,schema_version,last_seen_at) VALUES (?,?,?,1)",
        ).run(agentId, pathname, version);
      } finally {
        db.close();
      }
    };
    register(extra, "registry");
    const facts = new DoctorAgentSchemaFacts();
    await fleet.admit(facts);
    expect(fleet.copies).toContain(extra);
    mutate(shared, "DELETE FROM agent_databases WHERE agent_id='registry';");
    register(replacement, "new");
    fleet.copies.length = 0;
    facts.beginRefresh();
    await expect(fleet.inspect(facts)).rejects.toMatchObject({
      incompatibleDatabases: [
        expect.objectContaining({
          path: replacement,
          foundVersion: version + 1,
          supportedVersion: version,
        }),
      ],
    });
    expect(fleet.copies).toContain(shared);
    expect(fleet.copies).toContain(replacement);
    expect(fleet.copies).not.toContain(extra);
    facts.discard();
  });
});

it.each(["cleanup", "guard", "settled"] as const)(
  "gates header consumption through %s admission",
  async (phase) => {
    await withFleet(async (fleet) => {
      const facts = new DoctorAgentSchemaFacts();
      const input = {
        pathname: fleet.paths[0]!,
        agentId: "main",
        supportedVersion: version,
        env: process.env,
      };
      const cleanupStarted = createDeferred();
      const releaseCleanup = createDeferred();
      const guardStarted = createDeferred();
      const releaseGuard = createDeferred();
      let cleanupBlocked = false;
      const prepare = vi.mocked(snapshots.prepareSqliteReadOnlyLocation).getMockImplementation()!;
      vi.mocked(snapshots.prepareSqliteReadOnlyLocation).mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        if (args[0] === input.pathname && !cleanupBlocked) {
          cleanupBlocked = true;
          const cleanup = prepared.cleanupAsync;
          vi.spyOn(prepared, "cleanupAsync").mockImplementation(async () => {
            cleanupStarted.resolve();
            await releaseCleanup.promise;
            return cleanup();
          });
        }
        return prepared;
      });
      const admission = fleet.admit(facts, async () => {
        guardStarted.resolve();
        await releaseGuard.promise;
        return true;
      });
      try {
        await expect(
          Promise.race([
            cleanupStarted.promise.then(() => "blocked"),
            admission.then(() => "admitted"),
          ]),
        ).resolves.toBe("blocked");
        if (phase === "cleanup") {
          facts.beginRefresh();
          expect(await fleet.inspect(facts)).toMatchObject({ incompatible: [], indeterminate: [] });
          expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(2);
        }
        releaseCleanup.resolve();
        await expect(
          Promise.race([
            guardStarted.promise.then(() => "blocked"),
            admission.then(() => "admitted"),
          ]),
        ).resolves.toBe("blocked");
        if (phase === "guard") {
          facts.beginRefresh();
          expect(await fleet.inspect(facts)).toMatchObject({ incompatible: [], indeterminate: [] });
          expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(2);
        }
        releaseGuard.resolve();
        await admission;
        if (phase === "settled") {
          facts.beginRefresh();
          const header = facts.read(input);
          expect(header).toEqual({
            version,
            writerAppVersion: "fixture",
            agentSchemaMeta: { role: "agent", agentId: "main", schemaVersion: version },
          });
          expect(Object.isFrozen(header)).toBe(true);
          expect(Object.isFrozen(header?.agentSchemaMeta)).toBe(true);
        }
      } finally {
        releaseCleanup.resolve();
        releaseGuard.resolve();
        await Promise.allSettled([admission]);
        facts.discard();
      }
    });
  },
);

it.each(["guard", "cleanup false", "cleanup rejection"] as const)(
  "discards all staged facts after %s failure",
  async (failure) => {
    await withFleet(async (fleet) => {
      const facts = new DoctorAgentSchemaFacts();
      const retained: Array<{
        release: () => void;
        prepared: Awaited<ReturnType<typeof snapshots.prepareSqliteReadOnlyLocation>>;
      }> = [];
      const prepare = vi.mocked(snapshots.prepareSqliteReadOnlyLocation).getMockImplementation()!;
      if (failure !== "guard") {
        vi.mocked(snapshots.prepareSqliteReadOnlyLocation).mockImplementation(async (...args) => {
          const prepared = await prepare(...args);
          if (args[0] === fleet.paths[1]) {
            if (failure === "cleanup false") {
              retained.push({
                release: retainSnapshotTempDirectory(
                  prepared.cleanupRoot ?? path.dirname(prepared.location),
                ),
                prepared,
              });
            } else {
              const spy = vi
                .spyOn(prepared, "cleanupAsync")
                .mockRejectedValue(new Error("synthetic cleanup failure"));
              retained.push({ release: () => spy.mockRestore(), prepared });
            }
          }
          return prepared;
        });
      }
      try {
        if (failure === "guard") {
          await expect(fleet.admit(facts, async () => false)).rejects.toThrow(
            /selected config changed/,
          );
        } else {
          await fleet.admit(facts);
        }
        for (const item of retained) {
          expect(fs.existsSync(item.prepared.location)).toBe(true);
        }
      } finally {
        for (const item of retained) {
          item.release();
          expect(await item.prepared.cleanupAsync()).toBe(true);
        }
        vi.mocked(snapshots.prepareSqliteReadOnlyLocation).mockImplementation(prepare);
      }
      facts.beginRefresh();
      await fleet.inspect(facts);
      expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(2);
      facts.discard();
    });
  },
);

it("discards a cancelled admission and cannot reuse it in another attempt", async () => {
  await withFleet(async (fleet) => {
    const controller = new AbortController();
    const facts = new DoctorAgentSchemaFacts(controller.signal);
    await expect(
      withSqliteReadOnlyWorkerScope(
        () =>
          fleet.admit(facts, async () => {
            controller.abort(new Error("cancelled before publication"));
            return true;
          }),
        { signal: controller.signal, deadlineOwnedByCaller: false },
      ),
    ).rejects.toThrow(/cancelled/);
    const other = new DoctorAgentSchemaFacts();
    other.beginRefresh();
    await fleet.inspect(other);
    expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(2);
    expect(await fleet.inspect(facts)).toMatchObject({
      indeterminate: fleet.paths.map((pathname) => ({
        kind: "agent",
        path: pathname,
        reason: "cancelled before publication",
      })),
    });
    expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(0);
  });
});

it("keeps post-migration readiness fresh even when matching Doctor headers are available", async () => {
  await withFleet(async (fleet) => {
    const facts = new DoctorAgentSchemaFacts();
    await fleet.admit(facts);
    facts.beginRefresh();
    await fleet.inspect(facts);
    expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(0);
    // These header-only fixtures lack runtime tables. Fresh readiness must detect that.
    await withAgentDatabaseStartupAdmission(async () => {
      const result = await preflight.preflightOpenClawDatabaseSchemas({
        env: process.env,
        agentAdmissionConfig: fleet.config,
        configuredAgentDatabaseTargets: fleet.paths.map((pathname, index) => ({
          agentId: index ? "second" : "main",
          path: pathname,
        })),
        doctorAgentSchemaFacts: facts,
        verifyCurrentSchemaShape: true,
        requireStartupMigrationReadiness: true,
      });
      expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(2);
      expect(result.agentRefusals?.length).toBe(2);
    });
    facts.discard();
  });
});

it("honors a newly registered requested owner for an already inspected source", async () => {
  await withFleet(async (fleet) => {
    const shared = openOpenClawStateDatabase({ env: process.env }).path;
    await closeOpenClawStateDatabaseAsync();
    const facts = new DoctorAgentSchemaFacts();
    await fleet.admit(facts);
    const db = new DatabaseSync(shared);
    try {
      db.prepare(
        "INSERT INTO agent_databases(agent_id,path,schema_version,last_seen_at) VALUES ('second',?,?,1)",
      ).run(fleet.paths[0]!, version);
    } finally {
      db.close();
    }
    facts.beginRefresh();
    const result = await fleet.inspect(facts);
    expect(result.agentRefusals).toContainEqual(
      expect.objectContaining({
        agentId: "second",
        embeddedOwnerId: "main",
        paths: [fleet.paths[0]],
      }),
    );
    expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(1);
    facts.discard();
  });
});

it.each(["shm", "journal", "inspection mutation"] as const)(
  "misses uncertain generations after %s",
  async (change) => {
    await withFleet(async (fleet) => {
      const facts = new DoctorAgentSchemaFacts();
      const source = fleet.paths[0]!;
      const prepare = vi.mocked(snapshots.prepareSqliteReadOnlyLocation).getMockImplementation()!;
      if (change === "inspection mutation") {
        vi.mocked(snapshots.prepareSqliteReadOnlyLocation).mockImplementation(async (...args) => {
          const prepared = await prepare(...args);
          if (args[0] === source) {
            mutate(source, "UPDATE schema_meta SET app_version='changed during inspection';");
          }
          return prepared;
        });
      }
      await fleet.admit(facts);
      vi.mocked(snapshots.prepareSqliteReadOnlyLocation).mockImplementation(prepare);
      const sidecar = `${source}-${change}`;
      if (change !== "inspection mutation") {
        fs.writeFileSync(sidecar, "");
      }
      try {
        facts.beginRefresh();
        const result = await fleet.inspect(facts);
        expect(result.incompatible).toEqual([]);
        expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(1);
      } finally {
        if (change !== "inspection mutation") {
          fs.rmSync(sidecar, { force: true });
        }
        facts.discard();
      }
    });
  },
);

it("binds headers to the selected state root even when configured agent files are shared", async () => {
  await withFleet(async (fleet) => {
    const facts = new DoctorAgentSchemaFacts();
    await fleet.admit(facts);
    const otherRoot = path.join(fleet.home, "other-state");
    fs.mkdirSync(otherRoot);
    facts.beginRefresh();
    await preflight.preflightOpenClawDatabaseSchemas({
      env: { ...process.env, OPENCLAW_STATE_DIR: otherRoot },
      doctorAgentSchemaFacts: facts,
      agentAdmissionConfig: fleet.config,
      configuredAgentDatabaseTargets: fleet.paths.map((pathname, index) => ({
        agentId: index ? "second" : "main",
        path: pathname,
      })),
    });
    expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(2);
    facts.discard();
  });
});

it("does not publish headers from an actual Doctor run stopped during its first guard", async () => {
  await withFleet(async (fleet) => {
    await withAgentDatabaseStartupAdmission(async (admission) => {
      await expect(
        runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          requireStartupMigrationCheckpoint: true,
          beforeStateMigrations: async () => {
            await admission.stop();
            return true;
          },
        }),
      ).rejects.toThrow(/Gateway stopped/);
      expect(hasActiveStartupMigrationLease()).toBe(false);
    });
    await fleet.inspect(new DoctorAgentSchemaFacts());
    expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(2);
  });
});

it("keeps overlapping admission attempts independent when one fails its guard", async () => {
  await withFleet(async (fleet) => {
    const rejected = new DoctorAgentSchemaFacts();
    const admitted = new DoctorAgentSchemaFacts();
    const guardStarted = createDeferred();
    const releaseGuard = createDeferred();
    const first = fleet.admit(rejected, async () => {
      guardStarted.resolve();
      await releaseGuard.promise;
      return false;
    });
    const failure = expect(first).rejects.toThrow(/selected config changed/);
    try {
      await Promise.race([guardStarted.promise, first]);
      await fleet.admit(admitted);
      releaseGuard.resolve();
      await failure;
      admitted.beginRefresh();
      await fleet.inspect(admitted);
      expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(0);
      rejected.beginRefresh();
      await fleet.inspect(rejected);
      expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(2);
    } finally {
      releaseGuard.resolve();
      await Promise.allSettled([first, failure]);
      rejected.discard();
      admitted.discard();
    }
  });
});

it("never labels an inspected header with a symlink target selected after source resolution", async () => {
  await withFleet(async (fleet) => {
    const locator = fleet.paths[0]!;
    const inspectedSource = locator + ".owned";
    fs.renameSync(locator, inspectedSource);
    fs.symlinkSync(inspectedSource, locator);
    const foreignSource = seed(
      path.join(fleet.home, "foreign", "openclaw-agent.sqlite"),
      "foreign",
    );
    const facts = new DoctorAgentSchemaFacts();
    const prepare = facts.prepare.bind(facts);
    let retargeted = false;
    // Move only the locator after preflight selects its native source, before facts capture.
    vi.spyOn(facts, "prepare").mockImplementation((input) => {
      if (input.agentId === "main" && !retargeted) {
        fs.unlinkSync(locator);
        fs.symlinkSync(foreignSource, locator);
        retargeted = true;
      }
      return prepare(input);
    });
    const inspect = () =>
      preflight.preflightOpenClawDatabaseSchemas({
        env: process.env,
        agentAdmissionConfig: fleet.config,
        configuredAgentDatabaseTargets: fleet.paths.map((pathname, index) => ({
          agentId: index ? "second" : "main",
          path: pathname,
        })),
        doctorAgentSchemaFacts: facts,
      });
    try {
      const initial = await inspect();
      expect(initial).toMatchObject({ incompatible: [], indeterminate: [] });
      expect(initial.agentRefusals ?? []).toEqual([]);
      facts.publish();
      expect(retargeted).toBe(true);
      facts.beginRefresh();
      const refreshed = await inspect();
      expect(refreshed.agentRefusals ?? []).toContainEqual(
        expect.objectContaining({
          agentId: "main",
          embeddedOwnerId: "foreign",
          paths: [locator],
        }),
      );
      expect(fleet.stats.at(-1)?.schemaInspectionCount).toBe(1);
    } finally {
      facts.discard();
    }
  });
});
