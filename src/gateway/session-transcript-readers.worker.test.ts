import type { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  replaceSessionEntrySync,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readSessionMessageByIdAsync } from "./session-transcript-readers.js";

it("reads repeated broadcast messages through the admitted worker without host SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:worker-message",
      sessionId: "worker-message",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "answer",
        parentId: null,
        message: { role: "assistant", content: "retained worker answer" },
      },
    ]);
    // Admit config/registry sources as Gateway startup does before measuring hot reads.
    await readSessionMessageByIdAsync(scope, "answer");
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const statement: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const databasePrototype: DatabaseSync = Object.getPrototypeOf(database.db);
    const spies = [
      vi.spyOn(statement, "get"),
      vi.spyOn(statement, "all"),
      vi.spyOn(statement, "iterate"),
      vi.spyOn(statement, "run"),
      vi.spyOn(databasePrototype, "exec"),
    ];
    try {
      await expect(
        readSessionMessageByIdAsync(scope, "answer", {
          currentOnly: true,
          maxBytes: 10_000,
        }),
      ).resolves.toMatchObject({
        found: true,
        oversized: false,
        seq: 1,
        message: { role: "assistant", content: "retained worker answer" },
      });
      await expect(readSessionMessageByIdAsync(scope, "missing")).resolves.toEqual({
        found: false,
        oversized: false,
      });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

it("restores a worker-reported cold historical message without selecting its successor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createSessionColdStorageFixture(
      state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    await expect(
      runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    await expect(
      readSessionMessageByIdAsync(fixture.scope, "history-assistant"),
    ).resolves.toMatchObject({
      found: true,
      message: { role: "assistant", content: [{ type: "text", text: "Preserved response" }] },
    });
  });
});
