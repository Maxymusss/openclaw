import fs from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { loadExactSessionEntryCandidates } from "./session-accessor.sqlite-exact-read.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

it("reads exact current rows through the worker without caller SQLite and preserves physical ownership", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: state.statePath("exact.sqlite"),
    });
    const scope = { agentId: "other", storePath: database.path, sessionKey: "agent:other:exact" };
    replaceSessionEntrySync(scope, { sessionId: "exact", updatedAt: 1 });
    replaceSessionEntrySync(
      { ...scope, sessionKey: "agent:other:unrelated" },
      { sessionId: "unrelated", updatedAt: 2 },
    );
    const readSource = { agentId: database.agentId, path: database.path };
    const request = {
      sessionKeys: [scope.sessionKey, "agent:other:missing"],
      projection: "list" as const,
    };
    const expected = loadExactSessionEntryCandidates({ ...request, readSource, readOnly: true });
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const databasePrototype: DatabaseSync = Object.getPrototypeOf(database.db);
    const spies = [
      vi.spyOn(prototype, "all"),
      vi.spyOn(prototype, "get"),
      vi.spyOn(prototype, "iterate"),
      vi.spyOn(prototype, "run"),
      vi.spyOn(databasePrototype, "exec"),
    ];
    try {
      expect(
        await withSessionHistoryWorkerDatabase(readSource, (owner) =>
          owner.readExactEntries(request),
        ),
      ).toEqual({
        entries: expected,
        readSource,
        databaseIdentity: { identity: expect.any(String), filename: database.path },
      });
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
    replaceSessionEntrySync(scope, { sessionId: "replaced", updatedAt: 3 });
    expect(
      await withSessionHistoryWorkerDatabase(readSource, (owner) =>
        owner.readExactEntries(request),
      ),
    ).toMatchObject({
      entries: [{ sessionKey: scope.sessionKey, entry: { sessionId: "replaced" } }],
    });
    const missing = {
      agentId: "absent",
      path: resolveOpenClawAgentSqlitePath({ agentId: "absent" }),
    };
    expect(
      await withSessionHistoryWorkerDatabase(missing, (owner) =>
        owner.readExactEntries({ sessionKeys: ["agent:absent:main"] }),
      ),
    ).toEqual({ entries: [], readSource: undefined });
    expect(fs.existsSync(missing.path)).toBe(false);
  });
});

it("rejects exact results from a closing owner and allows a fresh owner after cleanup", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:exact-close" };
    replaceSessionEntrySync(scope, { sessionId: "before", updatedAt: 1 });
    const read = () =>
      withSessionHistoryWorkerDatabase({ agentId: "main" }, (owner) =>
        owner.readExactEntries({ sessionKeys: [scope.sessionKey] }),
      );
    const pending = read().then(
      () => "returned",
      () => "revoked",
    );
    await closeOpenClawAgentDatabasesAsync();
    expect(await pending).toBe("revoked");
    replaceSessionEntrySync(scope, { sessionId: "after", updatedAt: 2 });
    expect(await read()).toMatchObject({ entries: [{ entry: { sessionId: "after" } }] });
  });
});
