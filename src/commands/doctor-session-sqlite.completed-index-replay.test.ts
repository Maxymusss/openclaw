import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../config/sessions/session-accessor.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { rehomeSessionWindows } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  readTranscriptEventId,
  readTranscriptEventRows,
  readTranscriptStorageRows,
} from "../config/sessions/session-accessor.sqlite-read.js";
import {
  prepareSqliteTranscriptSuffixMutation,
  replaceSqliteTranscriptSuffixInTransaction,
} from "../config/sessions/session-accessor.sqlite-transcript-suffix.js";
import { appendTranscriptMessageSync } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import * as migrationArtifact from "../infra/session-sqlite-migration-artifact.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import * as sessionSqliteDiscovery from "./doctor-session-sqlite-discovery.js";
import {
  runDoctorSessionSqlite,
  settleRetainedDoctorSessionSources,
} from "./doctor-session-sqlite.js";
import {
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

function transcriptLines() {
  return [
    JSON.stringify({ type: "session", id: "session-1", version: 3, cwd: "/fixture" }),
    JSON.stringify({
      type: "message",
      id: "old-root",
      parentId: null,
      message: { role: "user", content: "old root" },
    }),
    JSON.stringify({
      type: "message",
      id: "stale-null-parent",
      parentId: null,
      message: { role: "assistant", content: "stale null parent" },
    }),
    JSON.stringify({
      type: "message",
      id: "stale-missing-parent",
      message: { role: "assistant", content: "stale missing parent" },
    }),
  ];
}

async function prepareCompletedImport(lines = transcriptLines(), withAlias = false) {
  const store = createLegacyStore({
    entryOverrides: { lifecycleRevision: "original-generation" },
    transcriptLines: lines,
  });
  if (withAlias) {
    const legacyStore = JSON.parse(fs.readFileSync(store.storePath, "utf8")) as Record<
      string,
      unknown
    >;
    legacyStore["agent:main:alias"] = legacyStore["agent:main:main"];
    fs.writeFileSync(store.storePath, `${JSON.stringify(legacyStore, null, 2)}\n`);
  }
  const imported = await runDoctorSessionSqlite({
    env: store.env,
    mode: "import",
    store: store.storePath,
  });
  expect(imported.targets[0]?.issues).toEqual([]);
  const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
  const target = expectDefined(manifest.targets[0], "completed import target");
  const indexMove = expectDefined(
    target.completedMoves.find((move) => move.kind === "legacy-store"),
    "completed index move",
  );
  const transcriptMove = expectDefined(
    target.completedMoves.find((move) => move.kind === "transcript"),
    "completed transcript move",
  );
  const scope = {
    agentId: "main",
    env: store.env,
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    storePath: store.storePath,
  };
  const aliasScope = { ...scope, sessionKey: "agent:main:alias" };
  return { aliasScope, indexMove, imported, manifest, scope, store, transcriptMove };
}

function copyCompletedSources(completed: Awaited<ReturnType<typeof prepareCompletedImport>>): void {
  for (const move of [completed.indexMove, completed.transcriptMove]) {
    fs.copyFileSync(move.archivePath, move.sourcePath);
  }
}

function expectReplaySourcesRetained(
  completed: Awaited<ReturnType<typeof prepareCompletedImport>>,
  report: Awaited<ReturnType<typeof runDoctorSessionSqlite>>,
): void {
  const moves = readMigrationManifest(report.migrationRun?.manifestPath).targets.flatMap(
    (target) => target.completedMoves,
  );
  for (const original of [completed.indexMove, completed.transcriptMove]) {
    expect(fs.readFileSync(original.sourcePath)).toEqual(fs.readFileSync(original.archivePath));
    expect(moves.some((move) => move.sourcePath === original.sourcePath)).toBe(false);
  }
  expect(report.totals).toMatchObject({
    archivedLegacyStoreFiles: 0,
    archivedTranscriptFiles: 0,
    archivedUnreferencedJsonlFiles: 0,
  });
}

function openCompletedDatabase(completed: Awaited<ReturnType<typeof prepareCompletedImport>>) {
  return openOpenClawAgentDatabase({ agentId: "main", env: completed.store.env });
}

function readCompletedTranscriptRows(
  completed: Awaited<ReturnType<typeof prepareCompletedImport>>,
) {
  return readTranscriptEventRows(openCompletedDatabase(completed), completed.scope.sessionId);
}

function withoutDisplayName(entry: NonNullable<ReturnType<typeof loadExactSessionEntry>>) {
  const { displayName: _displayName, ...owner } = entry.entry;
  return owner;
}

function removeTranscriptEvents(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  scope: Awaited<ReturnType<typeof prepareCompletedImport>>["scope"],
  eventIds: readonly string[],
): void {
  const events = readTranscriptEventRows(database, scope.sessionId).map(
    (row) => JSON.parse(row.eventJson) as TranscriptEvent,
  );
  const shouldRemove = (event: TranscriptEvent) => {
    const id = readTranscriptEventId(event);
    return id !== undefined && eventIds.includes(id);
  };
  const selected = events.filter(shouldRemove);
  expect(selected.map((event) => String(readTranscriptEventId(event))).toSorted()).toEqual(
    eventIds.toSorted(),
  );
  const next = events.filter((event) => !shouldRemove(event));
  const plan = prepareSqliteTranscriptSuffixMutation(database, scope, events, next);
  runOpenClawAgentWriteTransaction((transaction) => {
    replaceSqliteTranscriptSuffixInTransaction(transaction, scope, plan);
  }, scope);
  const remaining = readTranscriptEventRows(database, scope.sessionId).map(
    (row) => JSON.parse(row.eventJson) as TranscriptEvent,
  );
  expect(remaining).toHaveLength(events.length - eventIds.length);
  expect(remaining.some(shouldRemove)).toBe(false);
}

describe("completed legacy index replay", () => {
  it("settles a restored metadata-only index without touching current history", async () => {
    const store = createLegacyStore({
      entryOverrides: { lifecycleRevision: "original-generation", sessionFile: undefined },
    });
    fs.unlinkSync(store.transcriptPath);
    const imported = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    expect(imported.targets[0]?.issues).toEqual([]);
    const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
    const indexMove = expectDefined(
      manifest.targets[0]?.completedMoves.find((move) => move.kind === "legacy-store"),
      "completed metadata-only index move",
    );
    const scope = {
      agentId: "main",
      env: store.env,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    };
    await replaceSessionEntry(scope, {
      ...expectDefined(loadExactSessionEntry(scope), "metadata-only owner").entry,
      label: "current metadata-only owner",
      updatedAt: 9_000,
    });
    appendTranscriptMessageSync(scope, {
      eventId: "current-metadata-only-turn",
      message: { role: "user", content: "current metadata-only activity" },
    });
    const entryBefore = loadExactSessionEntry(scope);
    const contextBefore = SessionManager.open(scope).buildSessionContext();
    fs.copyFileSync(indexMove.archivePath, indexMove.sourcePath);

    const replayed = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(replayed.targets[0]?.issues).toEqual([]);
    expect(replayed.totals).toMatchObject({ importedEntries: 0, importedTranscriptEvents: 0 });
    expect(
      withoutDisplayName(expectDefined(loadExactSessionEntry(scope), "settled current owner")),
    ).toEqual(withoutDisplayName(expectDefined(entryBefore, "owner before metadata replay")));
    expect(SessionManager.open(scope).buildSessionContext()).toEqual(contextBefore);
    expect(fs.existsSync(store.storePath)).toBe(false);
  });

  it.each(["copied", "official"] as const)(
    "preserves a newer owner while settling a %s exact restore",
    async (restoreKind) => {
      const completed = await prepareCompletedImport();
      const current = {
        ...expectDefined(loadExactSessionEntry(completed.scope), "current entry").entry,
        abortedLastRun: false,
        label: "current owner",
        pinnedAt: 8_999,
        status: "running" as const,
        updatedAt: 9_000,
      };
      await replaceSessionEntry(completed.scope, current);
      appendTranscriptMessageSync(completed.scope, {
        eventId: "current-turn",
        message: { role: "user", content: "current activity" },
      });
      const entryBefore = loadExactSessionEntry(completed.scope);
      const contextBefore = SessionManager.open(completed.scope).buildSessionContext();

      if (restoreKind === "official") {
        const restored = await runDoctorSessionSqlite({
          env: completed.store.env,
          mode: "restore",
          store: completed.store.storePath,
        });
        expect(restored.targets[0]?.restore?.restoredFiles).toContain(
          completed.indexMove.sourcePath,
        );
      } else {
        copyCompletedSources(completed);
      }

      const replayed = await runDoctorSessionSqlite({
        env: completed.store.env,
        mode: "import",
        store: completed.store.storePath,
      });
      expect(replayed.targets[0]?.issues).toEqual([]);
      expect(replayed.totals).toMatchObject({
        importedEntries: 0,
        importedTranscriptEvents: 0,
      });
      expect(
        withoutDisplayName(expectDefined(loadExactSessionEntry(completed.scope), "replayed owner")),
      ).toEqual(withoutDisplayName(expectDefined(entryBefore, "owner before replay")));
      expect(SessionManager.open(completed.scope).buildSessionContext()).toEqual(contextBefore);
    },
  );

  it("settles a changed recognized prefix that is already canonical", async () => {
    const lines = transcriptLines();
    const completed = await prepareCompletedImport(lines);
    await replaceSessionEntry(completed.scope, {
      ...expectDefined(loadExactSessionEntry(completed.scope), "current entry").entry,
      label: "current prefix owner",
      updatedAt: 9_000,
    });
    const entryBefore = loadExactSessionEntry(completed.scope);
    const contextBefore = SessionManager.open(completed.scope).buildSessionContext();
    const rowsBefore = readCompletedTranscriptRows(completed);
    const database = openCompletedDatabase(completed);
    const windowBefore = database.db
      .prepare(
        "SELECT session_key, created_at, updated_at FROM session_windows WHERE session_id = ?",
      )
      .get(completed.scope.sessionId);
    fs.copyFileSync(completed.indexMove.archivePath, completed.indexMove.sourcePath);
    const prefixBytes = `${lines.slice(0, 2).join("\n")}\n`;
    fs.writeFileSync(completed.transcriptMove.sourcePath, prefixBytes, { mode: 0o600 });

    const evidence = sessionSqliteDiscovery.collectHistoricalArchiveSources({
      cfg: {},
      env: completed.store.env,
    });
    const replay = expectDefined(evidence.completedStoreReplays[0], "completed index replay");
    expect(replay.verifiedTranscriptIdentities.size).toBe(0);

    const replayed = await runDoctorSessionSqlite({
      env: completed.store.env,
      mode: "import",
      store: completed.store.storePath,
    });

    expect(replayed.targets[0]?.issues).toEqual([]);
    expect(replayed.totals).toMatchObject({ importedEntries: 0, importedTranscriptEvents: 0 });
    expect(loadExactSessionEntry(completed.scope)).toEqual(entryBefore);
    expect(SessionManager.open(completed.scope).buildSessionContext()).toEqual(contextBefore);
    expect(readCompletedTranscriptRows(completed)).toEqual(rowsBefore);
    expect(
      openCompletedDatabase(completed)
        .db.prepare(
          "SELECT session_key, created_at, updated_at FROM session_windows WHERE session_id = ?",
        )
        .get(completed.scope.sessionId),
    ).toEqual(windowBefore);
    const fresh = readMigrationManifest(replayed.migrationRun?.manifestPath);
    const freshTranscript = expectDefined(
      fresh.targets[0]?.completedMoves.find((move) => move.kind === "transcript"),
      "fresh transcript receipt",
    );
    expect(fs.readFileSync(freshTranscript.archivePath, "utf8")).toBe(prefixBytes);
  });

  it("settles restored legacy media against canonical history on repeated passes", async () => {
    const completed = await prepareCompletedImport([
      JSON.stringify({ type: "session", id: "session-1", version: 3, cwd: "/fixture" }),
      JSON.stringify({
        type: "message",
        id: "legacy-media",
        parentId: null,
        message: {
          role: "user",
          content: "legacy media",
          MediaPath: "/media/legacy.png",
          MediaType: "image/png",
        },
      }),
    ]);
    const database = openOpenClawAgentDatabase({ agentId: "main", env: completed.store.env });
    const entryBefore = loadExactSessionEntry(completed.scope);
    const rowsBefore = readTranscriptEventRows(database, completed.scope.sessionId);

    for (let pass = 0; pass < 2; pass += 1) {
      copyCompletedSources(completed);
      const replayed = await runDoctorSessionSqlite({
        env: completed.store.env,
        mode: "import",
        store: completed.store.storePath,
      });

      expect(replayed.targets[0]?.issues).toEqual([]);
      expect(replayed.totals).toMatchObject({
        importedEntries: 0,
        importedTranscriptEvents: 0,
      });
      expect(loadExactSessionEntry(completed.scope)).toEqual(entryBefore);
      expect(readCompletedTranscriptRows(completed)).toEqual(rowsBefore);
    }

    const event = JSON.parse(
      expectDefined(
        rowsBefore.find(
          (row) => (JSON.parse(row.eventJson) as { id?: unknown }).id === "legacy-media",
        ),
        "canonical legacy media row",
      ).eventJson,
    ) as { message?: Record<string, unknown> };
    expect(event.message).not.toHaveProperty("MediaPath");
    expect(event.message).not.toHaveProperty("MediaType");
    expect(event.message).toMatchObject({
      __openclaw: {
        media: [{ path: "/media/legacy.png", contentType: "image/png" }],
      },
    });
  });

  it("settles a completed alias replay without changing either owner row", async () => {
    const completed = await prepareCompletedImport(transcriptLines(), true);
    await replaceSessionEntry(completed.scope, {
      ...expectDefined(loadExactSessionEntry(completed.scope), "main owner").entry,
      displayName: "current main owner",
      label: "current main owner",
      updatedAt: 9_000,
    });
    await replaceSessionEntry(completed.aliasScope, {
      ...expectDefined(loadExactSessionEntry(completed.aliasScope), "alias owner").entry,
      displayName: "current alias owner",
      label: "current alias owner",
      updatedAt: 9_001,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: completed.store.env });
    const entriesBefore = [
      loadExactSessionEntry(completed.scope),
      loadExactSessionEntry(completed.aliasScope),
    ];
    const windowBefore = database.db
      .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
      .get(completed.scope.sessionId);
    copyCompletedSources(completed);
    const identities = vi.spyOn(migrationArtifact, "readMigrationArtifactIdentity");
    let replayed: Awaited<ReturnType<typeof runDoctorSessionSqlite>>;
    let boundIndexHashes = 0;
    try {
      replayed = await runDoctorSessionSqlite({
        env: completed.store.env,
        mode: "import",
        store: completed.store.storePath,
      });
      boundIndexHashes = identities.mock.calls.filter(
        ([filePath, , fingerprint]) =>
          filePath === completed.store.storePath && fingerprint !== undefined,
      ).length;
    } finally {
      identities.mockRestore();
    }

    expect(replayed.targets[0]?.issues).toEqual([]);
    expect(replayed.totals).toMatchObject({ importedEntries: 0, importedTranscriptEvents: 0 });
    expect([
      loadExactSessionEntry(completed.scope),
      loadExactSessionEntry(completed.aliasScope),
    ]).toEqual(entriesBefore);
    expect(
      openCompletedDatabase(completed)
        .db.prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
        .get(completed.scope.sessionId),
    ).toEqual(windowBefore);
    expect(boundIndexHashes).toBe(1);
    const replayManifest = readMigrationManifest(replayed.migrationRun?.manifestPath);
    const transcriptMove = expectDefined(
      replayManifest.targets
        .flatMap((target) => target.completedMoves)
        .find((move) => move.sourcePath === completed.transcriptMove.sourcePath),
      "settled replay transcript",
    );
    expect(transcriptMove.artifact).toMatchObject({
      classification: "imported",
      reason: "verified-import-original",
    });
  });

  it.each([false, true])(
    "lets the admitted alias append while retaining refused replay sources (pending plugin: %s)",
    async (pendingPlugin) => {
      const completed = await prepareCompletedImport(
        [
          JSON.stringify({ type: "session", id: "session-1", version: 3, cwd: "/fixture" }),
          JSON.stringify({
            type: "message",
            id: "alias-root",
            parentId: null,
            message: { role: "user", content: "alias root" },
          }),
          JSON.stringify({
            type: "message",
            id: "alias-tail",
            parentId: "alias-root",
            message: { role: "assistant", content: "alias tail" },
          }),
        ],
        true,
      );
      const database = openOpenClawAgentDatabase({ agentId: "main", env: completed.store.env });
      removeTranscriptEvents(database, completed.scope, ["alias-tail"]);
      await replaceSessionEntry(completed.scope, {
        ...expectDefined(loadExactSessionEntry(completed.scope), "main owner").entry,
        displayName: "new main generation",
        label: "new main generation",
        lifecycleRevision: "new-main-generation",
        updatedAt: 9_000,
      });
      await replaceSessionEntry(completed.aliasScope, {
        ...expectDefined(loadExactSessionEntry(completed.aliasScope), "alias owner").entry,
        displayName: "current alias owner",
        label: "current alias owner",
        updatedAt: 9_001,
      });
      runOpenClawAgentWriteTransaction((transaction) => {
        rehomeSessionWindows(transaction, completed.aliasScope.sessionKey, [
          completed.scope.sessionKey,
        ]);
      }, completed.scope);
      const entriesBefore = [
        loadExactSessionEntry(completed.scope),
        loadExactSessionEntry(completed.aliasScope),
      ];
      const windowBefore = database.db
        .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
        .get(completed.scope.sessionId);
      expect(windowBefore).toEqual({ session_key: completed.aliasScope.sessionKey });
      copyCompletedSources(completed);
      if (pendingPlugin) {
        recordDeferredPluginMigrations({
          env: completed.store.env,
          pending: [
            {
              pluginId: "fixture-plugin",
              reason: "Plugin is unavailable.",
              command: "openclaw doctor --fix",
            },
          ],
        });
      }

      const replayed = await runDoctorSessionSqlite({
        env: completed.store.env,
        mode: "import",
        store: completed.store.storePath,
      });

      expect(replayed.targets[0]?.issues).toContainEqual(
        expect.objectContaining({
          code: "historical_transcript_deferred",
          message: expect.stringContaining("generation changed"),
          sessionKey: completed.scope.sessionKey,
        }),
      );
      expect(replayed.totals).toMatchObject({ importedEntries: 0, importedTranscriptEvents: 1 });
      expectReplaySourcesRetained(completed, replayed);
      if (pendingPlugin) {
        await withDoctorSqliteMaintenanceLock({
          env: completed.store.env,
          operation: "completed replay plugin settlement",
          protectedPaths: [completed.store.storePath],
          run: async (authority) => {
            await settleRetainedDoctorSessionSources(replayed, ["fixture-plugin"], authority, () =>
              authority.assertCurrent(),
            );
            recordDeferredPluginMigrations({
              env: completed.store.env,
              pending: [],
              resolvedPluginIds: ["fixture-plugin"],
            });
          },
        });
        expectReplaySourcesRetained(completed, replayed);
      }
      expect([
        loadExactSessionEntry(completed.scope),
        loadExactSessionEntry(completed.aliasScope),
      ]).toEqual(entriesBefore);
      expect(
        openCompletedDatabase(completed)
          .db.prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get(completed.scope.sessionId),
      ).toEqual(windowBefore);
      expect(
        readCompletedTranscriptRows(completed).map(
          (row) => (JSON.parse(row.eventJson) as { id?: unknown }).id,
        ),
      ).toContain("alias-tail");
    },
  );

  it("keeps stale parentless history outside a reset active generation", async () => {
    const completed = await prepareCompletedImport();
    const database = openOpenClawAgentDatabase({ agentId: "main", env: completed.store.env });
    removeTranscriptEvents(database, completed.scope, [
      "old-root",
      "stale-null-parent",
      "stale-missing-parent",
    ]);
    await resetSessionEntryLifecycle({
      agentId: "main",
      storePath: completed.store.storePath,
      target: { canonicalKey: completed.scope.sessionKey, storeKeys: [completed.scope.sessionKey] },
      resetBoundary: { context: "clear", cwd: "/current", reason: "reset" },
      buildNextEntry: ({ currentEntry }) => ({
        ...expectDefined(currentEntry, "entry before reset"),
        lifecycleRevision: "reset-generation",
        updatedAt: 0,
      }),
    });
    appendTranscriptMessageSync(completed.scope, {
      eventId: "active-after-reset",
      message: { role: "user", content: "active after reset" },
    });
    const entryBefore = loadExactSessionEntry(completed.scope);
    const contextBefore = SessionManager.open(completed.scope).buildSessionContext();
    const rowsBefore = database.db.prepare("SELECT * FROM transcript_events ORDER BY seq").all();
    copyCompletedSources(completed);

    const replayed = await runDoctorSessionSqlite({
      env: completed.store.env,
      mode: "import",
      store: completed.store.storePath,
    });

    expect(replayed.targets[0]?.issues).toContainEqual(
      expect.objectContaining({
        code: "historical_transcript_deferred",
        message: expect.stringContaining("generation changed"),
      }),
    );
    expect(
      withoutDisplayName(expectDefined(loadExactSessionEntry(completed.scope), "reset owner")),
    ).toEqual(withoutDisplayName(expectDefined(entryBefore, "owner before reset replay")));
    expect(SessionManager.open(completed.scope).buildSessionContext()).toEqual(contextBefore);
    expect(
      openCompletedDatabase(completed)
        .db.prepare("SELECT * FROM transcript_events ORDER BY seq")
        .all(),
    ).toEqual(rowsBefore);
    expect(fs.existsSync(completed.indexMove.sourcePath)).toBe(true);
    expect(fs.existsSync(completed.transcriptMove.sourcePath)).toBe(true);
  });

  it.each([
    { name: "timestamped", timestamp: "2000-01-01T00:00:00.000Z" },
    { name: "timestamp-less", timestamp: undefined },
  ])(
    "recovers a receipt-verified $name tail without changing current activity",
    async ({ timestamp }) => {
      const completed = await prepareCompletedImport([
        JSON.stringify({ type: "session", id: "session-1", version: 3, cwd: "/fixture" }),
        JSON.stringify({
          type: "message",
          id: "verified-root",
          parentId: null,
          message: { role: "user", content: "verified root" },
        }),
        JSON.stringify({
          type: "message",
          id: "verified-suffix",
          parentId: "verified-root",
          message: {
            role: "assistant",
            content: "verified suffix",
            MediaPath: "/media/verified.png",
            MediaType: "image/png",
          },
          ...(timestamp === undefined ? {} : { timestamp }),
        }),
      ]);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: completed.store.env });
      removeTranscriptEvents(database, completed.scope, ["verified-suffix"]);
      const current = {
        ...expectDefined(loadExactSessionEntry(completed.scope), "current entry").entry,
        label: "newer owner",
        updatedAt: 9_000,
      };
      await replaceSessionEntry(completed.scope, current);
      const entryBefore = loadExactSessionEntry(completed.scope);
      const windowBefore = database.db
        .prepare(
          "SELECT session_key, created_at, updated_at FROM session_windows WHERE session_id = ?",
        )
        .get(completed.scope.sessionId);
      copyCompletedSources(completed);

      const replayStartedAt = Date.now();
      const replayed = await runDoctorSessionSqlite({
        env: completed.store.env,
        mode: "import",
        store: completed.store.storePath,
      });
      const replayFinishedAt = Date.now();

      expect(replayed.targets[0]?.issues).toEqual([]);
      expect(replayed.totals).toMatchObject({ importedEntries: 0, importedTranscriptEvents: 1 });
      expect(
        withoutDisplayName(expectDefined(loadExactSessionEntry(completed.scope), "current owner")),
      ).toEqual(withoutDisplayName(expectDefined(entryBefore, "owner before history recovery")));
      expect(
        openCompletedDatabase(completed)
          .db.prepare(
            "SELECT session_key, created_at, updated_at FROM session_windows WHERE session_id = ?",
          )
          .get(completed.scope.sessionId),
      ).toEqual(windowBefore);
      expect(SessionManager.open(completed.scope).buildSessionContext().messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "verified suffix" }],
          }),
        ]),
      );
      const suffix = expectDefined(
        readTranscriptStorageRows(openCompletedDatabase(completed), completed.scope.sessionId).find(
          (row) => (JSON.parse(row.eventJson) as { id?: unknown }).id === "verified-suffix",
        ),
        "restored verified suffix",
      );
      if (timestamp === undefined) {
        expect(suffix.createdAt).toBeGreaterThanOrEqual(replayStartedAt);
        expect(suffix.createdAt).toBeLessThanOrEqual(replayFinishedAt);
      } else {
        expect(suffix.createdAt).toBe(Date.parse(timestamp));
      }
      const suffixEvent = JSON.parse(suffix.eventJson) as {
        message?: Record<string, unknown>;
      };
      expect(suffixEvent.message).not.toHaveProperty("MediaPath");
      expect(suffixEvent.message).not.toHaveProperty("MediaType");
      expect(suffixEvent.message).toMatchObject({
        __openclaw: {
          media: [{ path: "/media/verified.png", contentType: "image/png" }],
        },
      });

      const rowsAfterAppend = readCompletedTranscriptRows(completed);
      copyCompletedSources(completed);
      const replayedAgain = await runDoctorSessionSqlite({
        env: completed.store.env,
        mode: "import",
        store: completed.store.storePath,
      });
      expect(replayedAgain.targets[0]?.issues).toEqual([]);
      expect(replayedAgain.totals).toMatchObject({
        importedEntries: 0,
        importedTranscriptEvents: 0,
      });
      expect(readCompletedTranscriptRows(completed)).toEqual(rowsAfterAppend);
      expect(
        openCompletedDatabase(completed)
          .db.prepare(
            "SELECT session_key, created_at, updated_at FROM session_windows WHERE session_id = ?",
          )
          .get(completed.scope.sessionId),
      ).toEqual(windowBefore);
    },
  );

  it.each([
    { name: "missing middle", removedId: "ordered-middle", appendNewer: false },
    { name: "missing tail after newer history", removedId: "ordered-tail", appendNewer: true },
  ])(
    "retains $name instead of reordering canonical history",
    async ({ removedId, appendNewer }) => {
      const completed = await prepareCompletedImport([
        JSON.stringify({ type: "session", id: "session-1", version: 3, cwd: "/fixture" }),
        JSON.stringify({
          type: "message",
          id: "ordered-root",
          parentId: null,
          message: { role: "user", content: "ordered root" },
        }),
        JSON.stringify({
          type: "message",
          id: "ordered-middle",
          parentId: "ordered-root",
          message: { role: "assistant", content: "ordered middle" },
        }),
        JSON.stringify({
          type: "message",
          id: "ordered-tail",
          parentId: "ordered-middle",
          message: { role: "user", content: "ordered tail" },
        }),
      ]);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: completed.store.env });
      removeTranscriptEvents(database, completed.scope, [removedId]);
      await replaceSessionEntry(completed.scope, {
        ...expectDefined(loadExactSessionEntry(completed.scope), "current entry").entry,
        label: "newer owner",
        updatedAt: 9_000,
      });
      if (appendNewer) {
        appendTranscriptMessageSync(completed.scope, {
          eventId: "newer-canonical-event",
          message: { role: "user", content: "newer canonical history" },
        });
      }
      const entryBefore = loadExactSessionEntry(completed.scope);
      const contextBefore = SessionManager.open(completed.scope).buildSessionContext();
      const rowsBefore = readTranscriptEventRows(database, completed.scope.sessionId);
      copyCompletedSources(completed);

      const replayed = await runDoctorSessionSqlite({
        env: completed.store.env,
        mode: "import",
        store: completed.store.storePath,
      });

      expect(replayed.targets[0]?.issues).toContainEqual(
        expect.objectContaining({
          code: "historical_transcript_deferred",
          message: expect.stringContaining("not an ordered suffix"),
        }),
      );
      expect(replayed.totals.importedTranscriptEvents).toBe(0);
      expect(
        withoutDisplayName(expectDefined(loadExactSessionEntry(completed.scope), "current owner")),
      ).toEqual(withoutDisplayName(expectDefined(entryBefore, "owner before refused replay")));
      expect(SessionManager.open(completed.scope).buildSessionContext()).toEqual(contextBefore);
      expect(readCompletedTranscriptRows(completed)).toEqual(rowsBefore);
      expect(fs.existsSync(completed.indexMove.sourcePath)).toBe(true);
      expect(fs.existsSync(completed.transcriptMove.sourcePath)).toBe(true);
    },
  );

  it("does not combine an index and transcript from different completed runs", async () => {
    const first = await prepareCompletedImport([
      JSON.stringify({ type: "session", id: "session-1", version: 3, cwd: "/fixture" }),
      JSON.stringify({
        type: "message",
        id: "receipt-root",
        parentId: null,
        message: { role: "user", content: "receipt root" },
      }),
    ]);
    const secondIndex = JSON.parse(fs.readFileSync(first.indexMove.archivePath, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    const secondEntry = expectDefined(secondIndex[first.scope.sessionKey], "second receipt entry");
    secondEntry.label = "second receipt";
    secondEntry.updatedAt = 3_000;
    const secondTranscript = [
      JSON.stringify({ type: "session", id: "session-1", version: 3, cwd: "/fixture" }),
      JSON.stringify({
        type: "message",
        id: "receipt-root",
        parentId: null,
        message: { role: "user", content: "receipt root" },
      }),
      JSON.stringify({
        type: "message",
        id: "second-receipt-tail",
        parentId: "receipt-root",
        message: { role: "assistant", content: "second receipt tail" },
      }),
    ];
    fs.writeFileSync(first.store.storePath, `${JSON.stringify(secondIndex, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(first.store.transcriptPath, `${secondTranscript.join("\n")}\n`, {
      mode: 0o600,
    });
    const secondReport = await runDoctorSessionSqlite({
      env: first.store.env,
      mode: "import",
      store: first.store.storePath,
    });
    expect(secondReport.targets[0]?.issues).toEqual([]);
    const secondManifest = readMigrationManifest(secondReport.migrationRun?.manifestPath);
    expect(first.manifest.completedAt).toBeTruthy();
    expect(secondManifest.completedAt).toBeTruthy();
    expect(secondManifest.runId).not.toBe(first.manifest.runId);
    const secondTarget = expectDefined(secondManifest.targets[0], "second completed target");
    const secondIndexMove = expectDefined(
      secondTarget.completedMoves.find((move) => move.kind === "legacy-store"),
      "second completed index move",
    );
    const secondTranscriptMove = expectDefined(
      secondTarget.completedMoves.find((move) => move.kind === "transcript"),
      "second completed transcript move",
    );
    expect(secondIndexMove.artifact?.identity.sha256).not.toBe(
      first.indexMove.artifact?.identity.sha256,
    );
    expect(secondTranscriptMove.artifact?.identity.sha256).not.toBe(
      first.transcriptMove.artifact?.identity.sha256,
    );

    const database = openOpenClawAgentDatabase({ agentId: "main", env: first.store.env });
    removeTranscriptEvents(database, first.scope, ["second-receipt-tail"]);
    await replaceSessionEntry(first.scope, {
      ...expectDefined(loadExactSessionEntry(first.scope), "current owner").entry,
      label: "current owner",
      updatedAt: 9_000,
    });
    const entryBefore = loadExactSessionEntry(first.scope);
    const contextBefore = SessionManager.open(first.scope).buildSessionContext();
    const rowsBefore = readTranscriptEventRows(database, first.scope.sessionId);
    fs.copyFileSync(first.indexMove.archivePath, first.indexMove.sourcePath);
    fs.copyFileSync(secondTranscriptMove.archivePath, secondTranscriptMove.sourcePath);

    const evidence = sessionSqliteDiscovery.collectHistoricalArchiveSources({
      cfg: {},
      env: first.store.env,
    });
    const restoredIndex = expectDefined(
      evidence.completedStoreReplays.find(
        (replay) => replay.move.archivePath === first.indexMove.archivePath,
      ),
      "first receipt index replay",
    );
    expect(evidence.completedStoreReplays).toHaveLength(1);
    expect(restoredIndex.verifiedTranscriptIdentities.size).toBe(0);

    const replayed = await runDoctorSessionSqlite({
      env: first.store.env,
      mode: "import",
      store: first.store.storePath,
    });

    expect(replayed.targets[0]?.issues).toContainEqual(
      expect.objectContaining({
        code: "historical_transcript_deferred",
        message: expect.stringContaining("not an ordered suffix"),
      }),
    );
    expect(replayed.totals.importedTranscriptEvents).toBe(0);
    expect(
      withoutDisplayName(expectDefined(loadExactSessionEntry(first.scope), "preserved owner")),
    ).toEqual(withoutDisplayName(expectDefined(entryBefore, "owner before mixed replay")));
    expect(SessionManager.open(first.scope).buildSessionContext()).toEqual(contextBefore);
    expect(readCompletedTranscriptRows(first)).toEqual(rowsBefore);
    expect(fs.existsSync(first.indexMove.sourcePath)).toBe(true);
    expect(fs.existsSync(secondTranscriptMove.sourcePath)).toBe(true);
  });

  it("does not classify a changed index as a completed replay", async () => {
    const completed = await prepareCompletedImport();
    copyCompletedSources(completed);
    fs.appendFileSync(completed.indexMove.sourcePath, "\n");

    const evidence = sessionSqliteDiscovery.collectHistoricalArchiveSources({
      cfg: {},
      env: completed.store.env,
    });

    expect(evidence.completedStoreReplays).toEqual([]);
    expect(fs.existsSync(completed.indexMove.sourcePath)).toBe(true);
  });

  it("retains an unverified restored transcript without appending it", async () => {
    const completed = await prepareCompletedImport();
    const entryBefore = loadExactSessionEntry(completed.scope);
    copyCompletedSources(completed);
    fs.appendFileSync(
      completed.transcriptMove.sourcePath,
      `${JSON.stringify({ type: "message", id: "unverified", parentId: null })}\n`,
    );

    const replayed = await runDoctorSessionSqlite({
      env: completed.store.env,
      mode: "import",
      store: completed.store.storePath,
    });

    expect(replayed.targets[0]?.issues).toContainEqual(
      expect.objectContaining({
        code: "historical_transcript_deferred",
        message: expect.stringContaining("could not be fully verified"),
      }),
    );
    expect(replayed.totals.importedTranscriptEvents).toBe(0);
    expect(
      withoutDisplayName(expectDefined(loadExactSessionEntry(completed.scope), "current owner")),
    ).toEqual(withoutDisplayName(expectDefined(entryBefore, "owner before changed transcript")));
    expect(fs.existsSync(completed.indexMove.sourcePath)).toBe(true);
    expect(fs.existsSync(completed.transcriptMove.sourcePath)).toBe(true);
  });

  it("refuses a restored transcript replaced after receipt discovery", async () => {
    const completed = await prepareCompletedImport();
    await replaceSessionEntry(completed.scope, {
      ...expectDefined(loadExactSessionEntry(completed.scope), "current entry").entry,
      label: "current owner",
      updatedAt: 9_000,
    });
    appendTranscriptMessageSync(completed.scope, {
      eventId: "current-before-source-swap",
      message: { role: "user", content: "current activity before source swap" },
    });
    const entryBefore = loadExactSessionEntry(completed.scope);
    const contextBefore = SessionManager.open(completed.scope).buildSessionContext();
    copyCompletedSources(completed);
    const collect = sessionSqliteDiscovery.collectHistoricalArchiveSources;
    let injected = false;
    const discovery = vi
      .spyOn(sessionSqliteDiscovery, "collectHistoricalArchiveSources")
      .mockImplementation((params) => {
        const evidence = collect(params);
        if (!injected) {
          const source = completed.transcriptMove.sourcePath;
          const replacement =
            fs.readFileSync(source, "utf8") +
            `${JSON.stringify({ type: "message", id: "replacement", parentId: null })}\n`;
          fs.unlinkSync(source);
          fs.writeFileSync(source, replacement);
          injected = true;
        }
        return evidence;
      });
    let replayed: Awaited<ReturnType<typeof runDoctorSessionSqlite>>;
    try {
      replayed = await runDoctorSessionSqlite({
        env: completed.store.env,
        mode: "import",
        store: completed.store.storePath,
      });
    } finally {
      discovery.mockRestore();
    }

    expect(injected).toBe(true);
    expect(replayed.targets[0]?.issues).toContainEqual(
      expect.objectContaining({
        code: "historical_transcript_deferred",
        message: expect.stringContaining("could not be fully verified"),
      }),
    );
    expect(replayed.totals.importedTranscriptEvents).toBe(0);
    expect(
      withoutDisplayName(expectDefined(loadExactSessionEntry(completed.scope), "current owner")),
    ).toEqual(withoutDisplayName(expectDefined(entryBefore, "owner before source swap")));
    expect(SessionManager.open(completed.scope).buildSessionContext()).toEqual(contextBefore);
    expect(fs.existsSync(completed.indexMove.sourcePath)).toBe(true);
    expect(fs.existsSync(completed.transcriptMove.sourcePath)).toBe(true);
  });

  it("does not resurrect a deleted canonical owner", async () => {
    const completed = await prepareCompletedImport();
    await deleteSessionEntryLifecycle({
      agentId: "main",
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
      storePath: completed.store.storePath,
      target: { canonicalKey: completed.scope.sessionKey, storeKeys: [completed.scope.sessionKey] },
    });
    expect(loadExactSessionEntry(completed.scope)).toBeUndefined();
    copyCompletedSources(completed);

    const replayed = await runDoctorSessionSqlite({
      env: completed.store.env,
      mode: "import",
      store: completed.store.storePath,
    });

    expect(replayed.targets[0]?.issues).toContainEqual(
      expect.objectContaining({
        code: "historical_transcript_deferred",
        message: expect.stringContaining("owner missing"),
      }),
    );
    expect(loadExactSessionEntry(completed.scope)).toBeUndefined();
    expect(fs.existsSync(completed.indexMove.sourcePath)).toBe(true);
  });

  it("does not grant replay authority to a failed receipt", async () => {
    const completed = await prepareCompletedImport();
    copyCompletedSources(completed);
    const manifestPath = expectDefined(
      completed.imported.migrationRun?.manifestPath,
      "completed manifest path",
    );
    const failed = readMigrationManifest(manifestPath);
    failed.failedAt = failed.completedAt;
    fs.writeFileSync(manifestPath, `${JSON.stringify(failed, null, 2)}\n`);

    const evidence = sessionSqliteDiscovery.collectHistoricalArchiveSources({
      cfg: {},
      env: completed.store.env,
    });

    expect(evidence.completedStoreReplays).toEqual([]);
  });
});
