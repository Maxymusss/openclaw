import type { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readAcpSessionMetaForEntriesInWorker,
  readAcpSessionMetaForEntry,
} from "./session-meta-readonly.js";
import { writeAcpSessionMetaForMigration } from "./session-meta.js";

it("prepares lifecycle-bound ACP metadata off thread while retaining embedded metadata and input order", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const sessionKey = "agent:main:acp:worker-read";
    const entry = { sessionId: "current", lifecycleRevision: "current-lifecycle", updatedAt: 1 };
    const meta: SessionAcpMeta = {
      backend: "acpx",
      agent: "fixture",
      runtimeSessionName: "synthetic-worker",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    };
    writeAcpSessionMetaForMigration({
      sessionKey,
      lifecycleRevision: entry.lifecycleRevision,
      meta,
    });
    const expected = readAcpSessionMetaForEntry({ sessionKey, entry });
    expect(expected).toEqual(meta);
    const embedded = { ...meta, backend: "embedded" };
    const database = openOpenClawStateDatabase();
    const statements: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const databases: DatabaseSync = Object.getPrototypeOf(database.db);
    const spies = [
      vi.spyOn(statements, "all"),
      vi.spyOn(statements, "get"),
      vi.spyOn(statements, "iterate"),
      vi.spyOn(statements, "run"),
      vi.spyOn(databases, "exec"),
    ];
    try {
      expect(
        await readAcpSessionMetaForEntriesInWorker({
          entries: [
            { sessionKey, entry },
            { sessionKey, entry: { ...entry, acp: embedded } },
            {
              sessionKey,
              entry: { ...entry, sessionId: "stale", lifecycleRevision: "stale-lifecycle" },
            },
            { sessionKey: "agent:main:missing", entry },
          ],
        }),
      ).toEqual([expected, embedded, undefined, undefined]);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
