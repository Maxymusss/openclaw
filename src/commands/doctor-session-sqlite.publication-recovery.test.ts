import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  readTranscriptEventId,
  readTranscriptEventRows,
} from "../config/sessions/session-accessor.sqlite-read.js";
import {
  prepareSqliteTranscriptSuffixMutation,
  replaceSqliteTranscriptSuffixInTransaction,
} from "../config/sessions/session-accessor.sqlite-transcript-suffix.js";
import * as directoryDurability from "../infra/directory-durability.js";
import * as migrationArtifact from "../infra/session-sqlite-migration-artifact.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import { ExitError } from "../runtime.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  runPublicSessionSqlite,
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  canonicalTestPath,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";
import { doctorCommand } from "./doctor.js";

const { createHistoricalRestoreStore, createVerifiedRecoveryStore } =
  useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each([
    { kind: "transcript", mode: "import", entry: "inner" },
    { kind: "legacy-store", mode: "import", entry: "inner" },
    { kind: "transcript", mode: "restore", entry: "inner" },
    { kind: "legacy-store", mode: "restore", entry: "inner" },
    { kind: "transcript", mode: "import", entry: "public" },
    { kind: "legacy-store", mode: "import", entry: "public" },
    { kind: "transcript", mode: "restore", entry: "public" },
    { kind: "legacy-store", mode: "restore", entry: "public" },
  ] as const)(
    "recovers interrupted $kind publication through $entry $mode",
    async ({ kind, mode, entry }) => {
      const { store } = await createVerifiedRecoveryStore();
      await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
      const source = kind === "transcript" ? store.transcriptPath : store.storePath;
      const original = fs.readFileSync(source);
      const token = "sk-abcdefghijklmnopqrstuv";
      const unlink = fs.unlinkSync;
      let injected = false;
      const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (!injected && file === source) {
          injected = true;
          throw new Error(
            `injected interruption before source unlink: Authorization: Bearer ${token}`,
          );
        }
        return unlink(file);
      });
      let interrupted;
      try {
        interrupted = await importLegacyStore(store);
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      const manifestPath = requireMigrationManifestPath(interrupted.migrationRun?.manifestPath);
      const move = readMigrationManifest(manifestPath).targets[0]!.plannedMoves.find(
        (item) => item.sourcePath === source,
      )!;
      const issueCode =
        kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed";
      const issue = interrupted.targets[0]?.issues.find((item) => item.code === issueCode);
      expect(issue?.message).toContain("injected interruption before source unlink");
      expect(issue?.message).not.toContain(token);
      expect(fs.readFileSync(source)).toEqual(original);
      expect(fs.statSync(source).nlink).toBe(2);
      expect(fs.statSync(source).ino).toBe(fs.statSync(move.archivePath).ino);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: expectDefined(interrupted.targets[0]?.sqlitePath, "SQLite target"),
      };
      if (kind === "legacy-store") {
        await replaceSessionEntry(scope, {
          ...expectDefined(loadExactSessionEntry(scope), "current owner").entry,
          label: "advanced current owner",
          updatedAt: 9_000,
        });
      }
      const database = openOpenClawAgentDatabase({ agentId: "main", env: store.env });
      const ownerBefore = kind === "legacy-store" ? loadExactSessionEntry(scope) : undefined;
      const rowsBefore =
        kind === "legacy-store" ? readTranscriptEventRows(database, "session-1") : undefined;
      const windowBefore =
        kind === "legacy-store"
          ? database.db
              .prepare(
                "SELECT session_key, created_at, updated_at FROM session_windows WHERE session_id = ?",
              )
              .get("session-1")
          : undefined;
      const transcriptArchive = readMigrationManifest(manifestPath).targets[0]!.completedMoves.find(
        (item) => item.kind === "transcript",
      )?.archivePath;
      if (entry === "public") {
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn((code: number): never => {
            throw new ExitError(code);
          }),
        };
        await expect(
          doctorCommand(runtime, {
            sessionSqlite: mode,
            sessionSqliteStore: store.storePath,
            json: true,
          }),
        ).rejects.toMatchObject({ code: 0 });
      } else {
        const recovered = await runDoctorSessionSqlite({
          env: store.env,
          mode,
          store: store.storePath,
        });
        expect(recovered.targets[0]?.issues).toEqual([]);
      }
      expect(readMigrationManifest(manifestPath).restore?.consumedArchives).toContain(
        move.archivePath,
      );
      expect(fs.existsSync(move.archivePath)).toBe(false);
      if (mode === "restore") {
        expect(fs.statSync(source).nlink).toBe(1);
        expect(fs.readFileSync(source)).toEqual(original);
        const reimport = await importLegacyStore(store);
        expect(reimport.targets[0]?.issues).toEqual([]);
      }
      if (kind === "legacy-store") {
        const currentDatabase = openOpenClawAgentDatabase({ agentId: "main", env: store.env });
        expect(loadExactSessionEntry(scope)).toEqual(ownerBefore);
        expect(readTranscriptEventRows(currentDatabase, "session-1")).toEqual(rowsBefore);
        expect(
          currentDatabase.db
            .prepare(
              "SELECT session_key, created_at, updated_at FROM session_windows WHERE session_id = ?",
            )
            .get("session-1"),
        ).toEqual(windowBefore);
        expect(fs.existsSync(store.transcriptPath)).toBe(false);
        if (mode === "import") {
          expect(transcriptArchive && fs.existsSync(transcriptArchive)).toBe(true);
        }
      }
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.status).toBe("complete");
      expect(cleanup.totals.removedFiles).toBe(2);
    },
  );

  it.each(["mismatch", "third-link"] as const)(
    "refuses public recovery of a recorded publication with %s",
    async (fault) => {
      const { store, imported } = await createVerifiedRecoveryStore();
      const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
      const move = manifest.targets[0]!.plannedMoves.find((item) => item.kind === "legacy-store")!;
      fs.linkSync(move.archivePath, move.sourcePath);
      const third = path.join(store.sessionDir, "unexpected-alias");
      if (fault === "third-link") {
        fs.linkSync(move.sourcePath, third);
      } else {
        fs.writeFileSync(move.sourcePath, "different bytes on the same inode");
      }
      const before = fs.readFileSync(move.sourcePath);
      for (const mode of ["import", "restore"] as const) {
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn((code: number): never => {
            throw new ExitError(code);
          }),
        };
        await expect(
          doctorCommand(runtime, {
            sessionSqlite: mode,
            sessionSqliteStore: store.storePath,
            json: true,
          }),
        ).rejects.toThrow(/hard-linked|publication paths changed/);
        expect(fs.readFileSync(move.sourcePath)).toEqual(before);
        expect(fs.readFileSync(move.archivePath)).toEqual(before);
        expect(fs.statSync(move.sourcePath).nlink).toBe(fault === "third-link" ? 3 : 2);
      }
    },
  );

  it("reuses one exact transcript archive across repeated index publication retries", async () => {
    const { store } = await createVerifiedRecoveryStore();
    await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
    const interruptIndexPublication = async () => {
      const unlink = fs.unlinkSync;
      const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (file === store.storePath) {
          throw new Error("injected repeated index publication interruption");
        }
        return unlink(file);
      });
      try {
        const report = await importLegacyStore(store);
        expect(report.targets[0]?.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "legacy_store_archive_failed" }),
          ]),
        );
      } finally {
        spy.mockRestore();
      }
    };

    await interruptIndexPublication();
    await interruptIndexPublication();
    const completed = await importLegacyStore(store);
    expect(completed.targets[0]?.issues).toEqual([]);
    const cleanup = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(cleanup.status).toBe("complete");
    expect(cleanup.totals.removedFiles).toBe(2);
  });

  it("reuses completed authority after an interrupted archive receipt", async () => {
    const { store } = await createVerifiedRecoveryStore();
    await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
    const unlink = fs.unlinkSync;
    const publicationSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (file === store.storePath) {
        throw new Error("injected index publication interruption");
      }
      return unlink(file);
    });
    let first;
    try {
      first = await importLegacyStore(store);
    } finally {
      publicationSpy.mockRestore();
    }
    const transcriptArchive = expectDefined(
      readMigrationManifest(first.migrationRun?.manifestPath).targets[0]?.completedMoves.find(
        (move) => move.kind === "transcript",
      )?.archivePath,
      "completed transcript archive",
    );
    const completed = migrationRun.recordCompletedMigrationMoves;
    let injected = false;
    const receiptSpy = vi
      .spyOn(migrationRun, "recordCompletedMigrationMoves")
      .mockImplementation((activeRun, target, moves) => {
        if (!injected && moves.some((move) => move.archivePath === transcriptArchive)) {
          injected = true;
          throw new Error("injected interruption before archive receipt");
        }
        return completed(activeRun, target, moves);
      });
    try {
      await expect(importLegacyStore(store)).rejects.toThrow(
        "injected interruption before archive receipt",
      );
    } finally {
      receiptSpy.mockRestore();
    }
    expect(injected).toBe(true);
    const retried = await importLegacyStore(store);
    expect(retried.targets[0]?.issues).toEqual([]);
  });

  it("uses a fresh settled receipt to append a missing canonical tail", async () => {
    const { store } = await createVerifiedRecoveryStore();
    await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
    const unlink = fs.unlinkSync;
    const publicationSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (file === store.storePath) {
        throw new Error("injected index publication interruption");
      }
      return unlink(file);
    });
    try {
      await importLegacyStore(store);
    } finally {
      publicationSpy.mockRestore();
    }
    const settled = await importLegacyStore(store);
    expect(settled.targets[0]?.issues).toEqual([]);
    const restored = await runDoctorSessionSqlite({
      env: store.env,
      mode: "restore",
      store: store.storePath,
    });
    expect(restored.targets[0]?.issues).toEqual([]);
    const scope = {
      agentId: "main",
      env: store.env,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: expectDefined(settled.targets[0]?.sqlitePath, "SQLite target"),
    };
    const database = openOpenClawAgentDatabase({ agentId: "main", env: store.env });
    const ownerBefore = loadExactSessionEntry(scope);
    const events = readTranscriptEventRows(database, scope.sessionId).map(
      (row) => JSON.parse(row.eventJson) as TranscriptEvent,
    );
    const next = events.filter((event) => readTranscriptEventId(event) !== "one");
    expect(next).toHaveLength(events.length - 1);
    const plan = prepareSqliteTranscriptSuffixMutation(database, scope, events, next);
    runOpenClawAgentWriteTransaction((transaction) => {
      replaceSqliteTranscriptSuffixInTransaction(transaction, scope, plan);
    }, scope);

    const replayed = await importLegacyStore(store);
    expect(replayed.targets[0]?.issues).toEqual([]);
    expect(replayed.totals.importedEntries).toBe(0);
    expect(replayed.totals.importedTranscriptEvents).toBe(1);
    expect(loadExactSessionEntry(scope)).toEqual(ownerBefore);
    expect(
      readTranscriptEventRows(
        openOpenClawAgentDatabase({ agentId: "main", env: store.env }),
        scope.sessionId,
      ).map((row) => JSON.parse(row.eventJson) as TranscriptEvent),
    ).toEqual(events);
  });

  it("retains a transcript source that reappears after archive admission", async () => {
    const { store } = await createVerifiedRecoveryStore();
    await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
    const unlink = fs.unlinkSync;
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (file === store.storePath) {
        throw new Error("injected index publication interruption");
      }
      return unlink(file);
    });
    let interrupted;
    try {
      interrupted = await importLegacyStore(store);
    } finally {
      spy.mockRestore();
    }
    const transcriptMove = expectDefined(
      readMigrationManifest(interrupted.migrationRun?.manifestPath).targets[0]?.completedMoves.find(
        (move) => move.kind === "transcript",
      ),
      "completed transcript archive",
    );
    const archived = fs.readFileSync(transcriptMove.archivePath);
    const indexBytes = fs.readFileSync(store.storePath);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: expectDefined(interrupted.targets[0]?.sqlitePath, "SQLite target"),
    };
    const ownerBefore = loadExactSessionEntry(scope);
    const database = openOpenClawAgentDatabase({ agentId: "main", env: store.env });
    const rowsBefore = readTranscriptEventRows(database, "session-1");
    const reappeared = Buffer.from("new unverified source\n");
    const recordPlanned = migrationRun.recordPlannedMigrationMoves;
    let appeared = false;
    const plannedSpy = vi
      .spyOn(migrationRun, "recordPlannedMigrationMoves")
      .mockImplementation((activeRun, target, moves) => {
        recordPlanned(activeRun, target, moves);
        if (!appeared && moves.some((move) => move.archivePath === transcriptMove.archivePath)) {
          appeared = true;
          fs.writeFileSync(store.transcriptPath, reappeared, { mode: 0o600 });
        }
      });
    let refused;
    try {
      refused = await importLegacyStore(store);
    } finally {
      plannedSpy.mockRestore();
    }
    expect(appeared).toBe(true);
    expect(refused.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "transcript_archive_failed",
          message: expect.stringContaining("changed before replay settlement"),
        }),
      ]),
    );
    expect(fs.readFileSync(store.transcriptPath)).toEqual(reappeared);
    expect(fs.readFileSync(transcriptMove.archivePath)).toEqual(archived);
    expect(fs.readFileSync(store.storePath)).toEqual(indexBytes);
    expect(loadExactSessionEntry(scope)).toEqual(ownerBefore);
    expect(
      readTranscriptEventRows(
        openOpenClawAgentDatabase({ agentId: "main", env: store.env }),
        "session-1",
      ),
    ).toEqual(rowsBefore);
  });

  it.each(["changed-archive", "competing-archive", "missing-canonical-tail"] as const)(
    "retains an interrupted replay with %s",
    async (fault) => {
      const { store } = await createVerifiedRecoveryStore();
      await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
      const unlink = fs.unlinkSync;
      const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (file === store.storePath) {
          throw new Error("injected index publication interruption");
        }
        return unlink(file);
      });
      let interrupted;
      try {
        interrupted = await importLegacyStore(store);
      } finally {
        spy.mockRestore();
      }
      const manifestPath = requireMigrationManifestPath(interrupted.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const transcriptMove = expectDefined(
        manifest.targets[0]?.completedMoves.find((move) => move.kind === "transcript"),
        "completed transcript archive",
      );
      const scope = {
        agentId: "main",
        env: store.env,
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: expectDefined(interrupted.targets[0]?.sqlitePath, "SQLite target"),
      };
      const database = openOpenClawAgentDatabase({ agentId: "main", env: store.env });
      let competingArchive: string | undefined;
      if (fault === "changed-archive") {
        fs.appendFileSync(transcriptMove.archivePath, '{"type":"event","id":"changed"}\n');
      } else if (fault === "competing-archive") {
        competingArchive = `${transcriptMove.archivePath}.competing`;
        fs.copyFileSync(transcriptMove.archivePath, competingArchive);
        const competingMove = {
          ...transcriptMove,
          archivePath: competingArchive,
          artifact: {
            ...expectDefined(transcriptMove.artifact, "transcript artifact"),
            identity: migrationArtifact.readMigrationArtifactIdentity(competingArchive),
          },
        };
        const target = expectDefined(manifest.targets[0], "migration target");
        const competingManifest = {
          ...manifest,
          runId: `${manifest.runId}-competing`,
          targets: [
            {
              ...target,
              completedMoves: [competingMove],
              plannedMoves: [competingMove],
            },
          ],
        };
        fs.writeFileSync(
          path.join(path.dirname(manifestPath), `${competingManifest.runId}.json`),
          `${JSON.stringify(competingManifest, null, 2)}\n`,
          { mode: 0o600 },
        );
      } else {
        const events = readTranscriptEventRows(database, scope.sessionId).map(
          (row) => JSON.parse(row.eventJson) as TranscriptEvent,
        );
        const next = events.filter((event) => readTranscriptEventId(event) !== "one");
        expect(next).toHaveLength(events.length - 1);
        const plan = prepareSqliteTranscriptSuffixMutation(database, scope, events, next);
        runOpenClawAgentWriteTransaction((transaction) => {
          replaceSqliteTranscriptSuffixInTransaction(transaction, scope, plan);
        }, scope);
      }
      const archiveBytes = fs.readFileSync(transcriptMove.archivePath);
      const competingBytes = competingArchive ? fs.readFileSync(competingArchive) : undefined;
      const indexBytes = fs.readFileSync(store.storePath);
      const ownerBefore = loadExactSessionEntry(scope);
      const rowsBefore = readTranscriptEventRows(database, scope.sessionId);
      const windowBefore = database.db
        .prepare(
          "SELECT session_key, created_at, updated_at FROM session_windows WHERE session_id = ?",
        )
        .get(scope.sessionId);

      const refused = await importLegacyStore(store);
      expect(refused.targets[0]?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "historical_transcript_deferred" }),
        ]),
      );
      const currentDatabase = openOpenClawAgentDatabase({ agentId: "main", env: store.env });
      expect(loadExactSessionEntry(scope)).toEqual(ownerBefore);
      expect(readTranscriptEventRows(currentDatabase, scope.sessionId)).toEqual(rowsBefore);
      expect(
        currentDatabase.db
          .prepare(
            "SELECT session_key, created_at, updated_at FROM session_windows WHERE session_id = ?",
          )
          .get(scope.sessionId),
      ).toEqual(windowBefore);
      expect(fs.readFileSync(store.storePath)).toEqual(indexBytes);
      expect(fs.existsSync(store.transcriptPath)).toBe(false);
      expect(fs.readFileSync(transcriptMove.archivePath)).toEqual(archiveBytes);
      if (competingArchive && competingBytes) {
        expect(fs.readFileSync(competingArchive)).toEqual(competingBytes);
      }
    },
  );

  it.each([1, 2] as const)(
    "protects historical v%s restore metadata and its retained transcript dependency from cleanup",
    async (version) => {
      const { store, manifestPath, manifest, archivePath } = createHistoricalRestoreStore(version);
      const target = expectDefined(manifest.targets[0], "historical cleanup target");
      const index = expectDefined(
        target.plannedMoves.find((move) => move.kind === "legacy-store"),
        "historical index",
      );
      const indexIdentity = migrationArtifact.readMigrationArtifactIdentity(index.archivePath);
      const indexBytes = fs.readFileSync(index.archivePath);
      const transcriptBytes = fs.readFileSync(archivePath);
      fs.writeFileSync(store.transcriptPath, "new source history\n", { mode: 0o600 });
      const publish = directoryDurability.publishFileExclusive;
      const publicationSpy = vi
        .spyOn(directoryDurability, "publishFileExclusive")
        .mockImplementation(async (options) => {
          if (options.sourcePath === index.archivePath && options.targetPath === index.sourcePath) {
            throw Object.assign(new Error("injected unsupported hard link"), { code: "EXDEV" });
          }
          return publish(options);
        });
      const copySpy = vi.spyOn(fs, "copyFileSync");
      const asyncCopySpy = vi.spyOn(fsPromises, "copyFile");
      try {
        const failed = await runPublicSessionSqlite(store, "restore");
        expect(failed.exitCode).toBe(1);
        expect(failed.report.targets[0]?.restore?.conflicts).toEqual(
          expect.arrayContaining([expect.objectContaining({ archivePath: index.archivePath })]),
        );
        expect(publicationSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sourcePath: index.archivePath,
            targetPath: index.sourcePath,
            strategy: "link-required",
          }),
        );
        expect(copySpy).not.toHaveBeenCalled();
        expect(asyncCopySpy).not.toHaveBeenCalled();
      } finally {
        publicationSpy.mockRestore();
        copySpy.mockRestore();
        asyncCopySpy.mockRestore();
      }
      const recorded = readMigrationManifest(manifestPath);
      expect(recorded.manifestVersion).toBe(version);
      const indexMoves = [
        ...recorded.targets[0]!.plannedMoves,
        ...recorded.targets[0]!.completedMoves,
      ].filter((move) => move.archivePath === index.archivePath);
      expect(indexMoves).toHaveLength(2);
      for (const move of indexMoves) {
        expect(move.artifact).toMatchObject({
          classification: "protected",
          disposal: { state: "retained" },
          identity: indexIdentity,
          dependencies: [canonicalTestPath(store.transcriptPath)],
        });
      }
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.find((item) => item.path === index.archivePath)?.outcome).toBe(
        "protected",
      );
      expect(preview.artifacts.find((item) => item.path === archivePath)).toMatchObject({
        outcome: "protected",
        reason: "retained-recovery-dependency",
      });
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview,
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.totals.removedFiles).toBe(0);
      expect(fs.readFileSync(index.archivePath)).toEqual(indexBytes);
      expect(fs.readFileSync(archivePath)).toEqual(transcriptBytes);
      expect(fs.readFileSync(store.transcriptPath, "utf8")).toBe("new source history\n");
      expect(fs.existsSync(index.sourcePath)).toBe(false);
      expect(fs.existsSync(target.sqlitePath)).toBe(false);
    },
  );
});
