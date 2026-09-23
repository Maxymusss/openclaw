import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRetainedAgentDatabaseMatcherFromSnapshot } from "./agent-deletion-discovery.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
  removeAgentDeletionJournal,
} from "./agent-deletion-journal.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "./agent-deletion-journal.read.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

it("reads fresh deletion and surviving-owner facts from its captured source without host SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const survivor = openOpenClawAgentDatabase({ agentId: "survivor", env: state.env });
    const agentDir = state.agentDir("retired");
    const options = { env: state.env };
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId: "retained-owner",
        agentDir,
        workspaceDir: state.workspaceDir,
        sessionsDir: state.sessionsDir("retired"),
        databasePaths: [survivor.path],
        deleteFiles: false,
      },
      options,
    );
    runOpenClawStateWriteTransaction((database) => {
      expect(completeAgentDeletionJournalInDatabase(database, "retired", "retained-owner")).toBe(
        true,
      );
    }, options);
    const input = {
      path: resolveOpenClawStateSqlitePath(state.env),
      env: { ...state.env },
    };
    const prepared = prepareAgentDatabaseDeletionSnapshotRead(input);
    input.path = state.statePath("replacement.sqlite");
    input.env.OPENCLAW_STATE_DIR = state.statePath("replacement-state");
    const observation = observeHostDataSql(state.env);
    try {
      const { snapshot, assertCurrent } = await prepared.read();
      expect(snapshot).toMatchObject({
        retainedDeletions: [
          {
            agentId: "retired",
            agentDir,
            databasePaths: expect.arrayContaining([
              path.join(agentDir, "openclaw-agent.sqlite"),
              survivor.path,
            ]),
          },
        ],
        registeredAgentDatabases: expect.arrayContaining([
          expect.objectContaining({ agentId: "survivor", path: survivor.path }),
        ]),
      });
      const isRetained = createRetainedAgentDatabaseMatcherFromSnapshot(
        state.env,
        () => [],
        snapshot,
      );
      expect(isRetained(survivor.path, "survivor")).toBeUndefined();
      expect(isRetained(survivor.path, "retired")).toMatchObject({ agentId: "retired" });
      expect(assertCurrent).not.toThrow();
      expect(observation.queries).toEqual([]);
      for (const call of observation.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      observation.restore();
    }
    expect(removeAgentDeletionJournal("retired", "retained-owner", options)).toBe(true);
    expect((await prepared.read()).snapshot?.retainedDeletions).toEqual([]);
  });
});

it.each(["source", "maintenance"] as const)(
  "does not reacquire a captured deletion snapshot after its %s lifetime ends",
  async (lifetime) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { env: state.env };
      const database = openOpenClawStateDatabase(options);
      const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
      try {
        const prepared = maintenance.run(() => prepareAgentDatabaseDeletionSnapshotRead(options));
        const { assertCurrent } = await prepared.read();
        expect(assertCurrent).not.toThrow();
        if (lifetime === "source") {
          await closeOpenClawStateDatabaseByPathAsync(database.path);
          openOpenClawStateDatabase(options);
        } else {
          await maintenance.close();
        }
        expect(assertCurrent).toThrow();
        await expect(prepared.read()).rejects.toThrow();
        expect(
          (await prepareAgentDatabaseDeletionSnapshotRead(options).read()).snapshot,
        ).toBeDefined();
      } finally {
        await maintenance.close();
      }
    });
  },
);

it("keeps absent discovery conservative without creating shared state or sidecars", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async (state) => {
    const pathname = resolveOpenClawStateSqlitePath(state.env);
    const files = [pathname, `${pathname}-wal`, `${pathname}-shm`, `${pathname}-journal`];
    expect(files.map((file) => fs.existsSync(file))).toEqual([false, false, false, false]);
    const result = await prepareAgentDatabaseDeletionSnapshotRead({ env: state.env }).read();
    expect(result.snapshot).toBeUndefined();
    expect(result.assertCurrent).not.toThrow();
    const isRetained = createRetainedAgentDatabaseMatcherFromSnapshot(
      state.env,
      () => [],
      result.snapshot,
    );
    expect(isRetained(state.statePath("unknown.sqlite"), "unknown")).toBe(true);
    expect(files.map((file) => fs.existsSync(file))).toEqual([false, false, false, false]);
  });
});
