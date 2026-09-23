import { afterEach, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

afterEach(() => vi.restoreAllMocks());

it.each(["config", "identity scopes", "dispose", "source"] as const)(
  "does not publish a topology snapshot after its %s changes while reading",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      let cfg: OpenClawConfig = {
        agents: { entries: { main: { identity: { name: "Original" } } } },
      };
      const query = { agentId: "main", key: "agent:main:topology" };
      replaceSessionEntrySync(
        { agentId: query.agentId, sessionKey: query.key },
        { sessionId: "topology", updatedAt: 1 },
      );
      const releaseForeground = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({
        cfg,
        getConfig: () => cfg,
        modelCatalog: [],
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const originalRead = stateReads.executeExistingOpenClawStateRead;
      let held = false;
      vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
        async (...args) => {
          const reply = await originalRead(...args);
          if (args[1].type === "agentDatabaseDeletion.snapshot" && !held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return reply;
        },
      );
      const captured = projection.capture(query);
      sessionChanges.emit({ all: true, scope: "stores" });
      const pending = projection.prepareMembership();
      const settled = Promise.allSettled([pending]);
      try {
        await withTestTimeout(entered.promise, 2_000, "Topology snapshot did not reach its owner");
        expect(projection.capture(query)).toBe(captured);
        if (change === "config") {
          cfg = { agents: { entries: { main: { identity: { name: "Replacement" } } } } };
          sessionChanges.emit({ all: true, scope: "config" });
        } else if (change === "identity scopes") {
          cfg = {
            ...cfg,
            gateway: { auth: { identityScopes: { "reader@example.test": ["operator.read"] } } },
          };
          sessionChanges.emit({ all: true, scope: "config" });
        } else if (change === "dispose") {
          projection.dispose();
        } else {
          const database = openOpenClawStateDatabase({ env: state.env });
          await closeOpenClawStateDatabaseByPathAsync(database.path);
          openOpenClawStateDatabase({ env: state.env });
        }
        release.resolve();
        if (change === "source") {
          expect(await settled).toEqual([{ status: "rejected", reason: expect.any(Error) }]);
          await expect(projection.prepareMembership()).rejects.toThrow();
        } else {
          expect(await settled).toEqual([{ status: "fulfilled", value: undefined }]);
          if (change === "config" || change === "identity scopes") {
            expect(projection.state.cfg).toBe(cfg);
            expect(projection.selectEntries().map((row) => row.entry.sessionId)).toEqual([
              "topology",
            ]);
          } else {
            expect(projection.capture(query)).toBeUndefined();
            expect(projection.selectEntries()).toEqual([]);
          }
        }
      } finally {
        release.resolve();
        await settled;
        projection.dispose();
        releaseForeground();
      }
    });
  },
);

it.each(["chat.startup", "sessions.resolve"] as const)(
  "revalidates request authority after %s topology readiness",
  async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const prepare = projection.prepareMembership;
      vi.spyOn(projection, "prepareMembership").mockImplementationOnce(async () => {
        await prepare();
        entered.resolve();
        await release.promise;
      });
      const respond = vi.fn();
      const revoked = new Error("Original request authority ended");
      let active = true;
      const handler =
        method === "chat.startup" ? chatHistoryHandlers[method]! : sessionReadHandlers[method]!;
      const pending = Promise.resolve(
        handler({
          req: { type: "req", id: "topology-authority", method },
          params:
            method === "chat.startup"
              ? { shortId: "87654321", agentId: "main" }
              : { key: "agent:main:missing" },
          client: null,
          context,
          respond,
          isWebchatConnect: () => false,
          sessionMutationAuthorization: {
            assertCurrent() {
              if (!active) {
                throw revoked;
              }
            },
            assertTargetCurrent() {},
          },
        }),
      );
      const settled = Promise.allSettled([pending]);
      try {
        await withTestTimeout(entered.promise, 2_000, "Request did not await topology readiness");
        active = false;
        release.resolve();
        expect(await settled).toEqual([{ status: "rejected", reason: revoked }]);
        expect(respond).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await settled;
        projection.dispose();
      }
    });
  },
);
