import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import * as workerReads from "../config/sessions/session-transcript-worker-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";

afterEach(() => vi.restoreAllMocks());
const cfg = { agents: { entries: { main: {} } } };
const target = { agentId: "main", sessionKey: "agent:main:worker-read" };
const query = { agentId: target.agentId, key: target.sessionKey };

it("keeps cold archive membership current without main-thread SQLite or materializing the roster", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(target, {
      sessionId: "archive",
      updatedAt: 1,
      archivedAt: 1,
      activitySummary: {
        version: 1,
        formatRevision: 2,
        text: "Synthetic summary",
        updatedAt: 1,
        sessionId: "archive",
        generation: null,
        maxSeq: null,
        leafEntryId: null,
        coveredMessages: 0,
        totalMessages: 0,
        omittedContent: false,
      },
    });
    addSessionMember(target, { identityId: "viewer", addedBy: "owner" });
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: new Map([
        [
          "main",
          createPreparedGatewayModelCatalog({
            entries: [],
            pluginRegistry: createEmptyPluginRegistry(),
            metadataSnapshot: createPluginMetadataSnapshotFixture(),
          }),
        ],
      ]),
    });
    try {
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(0);
      expect(projection.readMembership(query)?.has("viewer")).toBe(true);
      removeSessionMember(target, "viewer");
      const statements = [
        vi.spyOn(DatabaseSync.prototype, "exec"),
        ...(["all", "get", "iterate", "run"] as const).map((method) =>
          vi.spyOn(StatementSync.prototype, method),
        ),
      ];
      try {
        await projection.ensureMaterialized();
        expect(projection.readMembership(query)?.has("viewer")).toBe(false);
        expect(projection.materializedCount).toBe(0);
        await projection.withPreparedExactRows(
          () => [query],
          (read) => {
            expect(read.describe(query)?.entry.sessionId).toBe("archive");
            expect(read.readMembership(query)?.has("viewer")).toBe(false);
          },
        );
        for (const statement of statements) expect(statement).not.toHaveBeenCalled();
      } finally {
        for (const statement of statements) statement.mockRestore();
      }
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      expect(projection.describe(query)).toBeUndefined();
      expect(projection.readMembership(query)?.has("viewer")).toBe(false);
    } finally {
      projection.dispose();
      release();
    }
  });
});

it.each(["replace", "dispose"] as const)(
  "does not publish a delayed worker reply after %s",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      replaceSessionEntrySync(target, { sessionId: "original", updatedAt: 1 });
      const release = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg });
      const arrived = createDeferredCore();
      const resume = createDeferredCore();
      const realRead = workerReads.withSessionHistoryWorkerDatabases;
      let delay = true;
      vi.spyOn(workerReads, "withSessionHistoryWorkerDatabases").mockImplementation(
        (options, consume) =>
          realRead(options, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                async readExactEntries(scope) {
                  const result = await owner.readExactEntries(scope);
                  if (delay) {
                    delay = false;
                    arrived.resolve();
                    await resume.promise;
                  }
                  return result;
                },
              })),
            ),
          ),
      );
      try {
        replaceSessionEntrySync(target, { sessionId: "stale", updatedAt: 2 });
        const pending = projection.ensureMaterialized();
        await arrived.promise;
        if (operation === "replace") {
          replaceSessionEntrySync(target, { sessionId: "current", updatedAt: 3 });
        } else {
          projection.dispose();
        }
        resume.resolve();
        await pending;
        expect(projection.describe(query)?.entry.sessionId).toBe(
          operation === "replace" ? "current" : undefined,
        );
        if (operation === "dispose") {
          await expect(projection.prepareExactRows([query])).rejects.toThrow("no longer active");
        }
      } finally {
        resume.resolve();
        projection.dispose();
        release();
      }
    });
  },
);
