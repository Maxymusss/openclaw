import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withCurrentSessionListRows } from "../session-list-read-result.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";
import { sessionReadHandlers } from "./sessions-read.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

function viewerConfig(others: "view" | "none"): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "viewer",
        definitions: {
          viewer: {
            agents: "*",
            scopes: ["operator.read", "operator.write"],
            sessions: { others },
          },
        },
      },
    },
  };
}

it.each(["sessions.list", "sessions.describe"] as const)(
  "%s retains its original model ceiling through actual placement readiness",
  async (method) => {
    for (const change of ["widen", "remove", "tighten", "allowed", "omitted", "revoke"] as const) {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const viewer = ensureProfileForEmail("model-reader@example.test").id;
        const owner = ensureProfileForEmail("model-owner@example.test").id;
        const scope = { agentId: "main", sessionKey: "agent:main:model-read" };
        let config = viewerConfig("view");
        config.agents = { entries: { main: {} }, defaults: { model: "fixture/model-b" } };
        const role = expectDefined(config.gateway?.roles?.definitions.viewer, "viewer role");
        if (change !== "omitted") {
          role.models = {
            allow:
              change === "tighten" || change === "allowed"
                ? ["fixture/model-a", "fixture/model-b"]
                : ["fixture/model-a"],
          };
        }
        setRuntimeConfigSnapshot(config);
        const context = requestContext(config);
        context.getRuntimeConfig = () => config;
        const entered = createDeferred();
        const release = createDeferred();
        let hold = false;
        let current = true;
        const projection = await createSessionRowProjection({
          cfg: config,
          getConfig: context.getRuntimeConfig,
          context,
          placementFactsReader: {
            async readProjection() {
              if (hold) {
                entered.resolve();
                await release.promise;
              }
              return {
                placements: new Map(),
                moves: new Map(),
                environments: new Map(),
                workspaceResultReconcilingSessionIds: new Set(),
              };
            },
          },
        });
        bindSessionRowProjection(context, () => projection);
        replaceSessionEntrySync(scope, {
          sessionId: "model-read-generation",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: owner },
          providerOverride: "fixture",
          modelOverride: "model-b",
        });
        hold = true;
        const respond = vi.fn<RespondFn>();
        const params = method === "sessions.list" ? { agentId: "main" } : { key: scope.sessionKey };
        const pending = expectDefined(
          sessionReadHandlers[method],
          "read handler",
        )({
          req: { type: "req", id: "model-read", method, params },
          params,
          context,
          client: identifiedClient(viewer),
          respond,
          hasCurrentClientAuthority: () => current,
          isWebchatConnect: () => false,
        });
        const settled = Promise.resolve(pending);
        void settled.catch(() => {});
        try {
          expect(
            await Promise.race([
              entered.promise.then(() => "held"),
              settled.then(() => "finished"),
            ]),
          ).toBe("held");
          if (change === "revoke") {
            current = false;
          } else if (change === "widen" || change === "remove" || change === "tighten") {
            config = structuredClone(config);
            const next = expectDefined(
              config.gateway?.roles?.definitions.viewer,
              "current viewer role",
            );
            if (change === "remove") {
              delete next.models;
            } else {
              next.models = {
                allow:
                  change === "widen" ? ["fixture/model-a", "fixture/model-b"] : ["fixture/model-a"],
              };
            }
            setRuntimeConfigSnapshot(config);
          }
          release.resolve();
          if (change === "revoke") {
            await expect(settled).rejects.toThrow("Gateway caller authority is no longer active.");
            expect(respond).not.toHaveBeenCalled();
          } else {
            await settled;
            expect(respond).toHaveBeenCalledOnce();
            expect(respond.mock.calls[0]?.[0]).toBe(true);
            const payload = respond.mock.calls[0]?.[1];
            const visible = change === "allowed" || change === "omitted";
            if (method === "sessions.list") {
              expect(payload).toMatchObject({
                sessions: [{ key: scope.sessionKey, sharingRole: "viewer" }],
                defaults: { model: visible ? "model-b" : null },
              });
              if (
                payload &&
                typeof payload === "object" &&
                "sessions" in payload &&
                Array.isArray(payload.sessions)
              ) {
                expect(
                  await withCurrentSessionListRows(payload.sessions, (rows) => rows, true),
                ).toEqual([true]);
              } else {
                throw new Error("Expected the real list result");
              }
            } else {
              expect(payload).toMatchObject({
                session: { key: scope.sessionKey, sharingRole: "viewer" },
              });
            }
            expect(JSON.stringify(payload).includes("model-b")).toBe(visible);
          }
        } finally {
          release.resolve();
          await settled.catch(() => {});
          projection.dispose();
        }
      });
    }
  },
);

it.each([
  "membership",
  "membership-unpublished",
  "membership-external",
  "visibility",
  "identity",
  "config",
] as const)(
  "rechecks current %s after the resident projection has completed asynchronous preparation",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const viewer = ensureProfileForEmail("page-viewer@example.test").id;
      const owner = ensureProfileForEmail("page-owner@example.test").id;
      const scope = { agentId: "main", sessionKey: "agent:main:selected-page" };
      const membershipChange = change.startsWith("membership");
      const replacementKey = "agent:main:replacement-page";
      const selected: SessionEntry = {
        sessionId: "selected-page",
        updatedAt: 300,
        visibility: change === "identity" ? "draft" : membershipChange ? "read-only" : "shared",
        createdActor: {
          type: "human",
          source: "profile",
          id: change === "identity" ? viewer : owner,
        },
      };
      replaceSessionEntrySync(scope, selected);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: replacementKey },
        {
          sessionId: "replacement-page",
          updatedAt: 200,
          visibility: "shared",
          createdActor: {
            type: "human",
            source: "profile",
            id: change === "identity" ? owner : viewer,
          },
        },
      );
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:tail-page" },
        {
          sessionId: "tail-page",
          updatedAt: 100,
          visibility: "shared",
          createdActor: {
            type: "human",
            source: "profile",
            id: change === "identity" ? owner : viewer,
          },
        },
      );
      if (membershipChange) {
        addSessionMember(scope, { identityId: viewer, addedBy: owner });
      }
      let config = viewerConfig("view");
      const context = requestContext(config);
      context.getRuntimeConfig = () => config;
      const client = identifiedClient(viewer);
      const request = { agentId: "main", limit: 1, includeActivitySummary: true };
      const before = await listSessions({ client, context, request });
      expect(before.sessions).toMatchObject([
        { key: scope.sessionKey, sessionId: selected.sessionId },
      ]);
      const projection = expectDefined(getSessionRowProjection(context), "resident projection");
      const ready = projection.ensureMaterialized.bind(projection);
      vi.spyOn(projection, "ensureMaterialized").mockImplementationOnce(async () => {
        await ready();
        // Resume the real request only after its current authority has changed.
        if (change === "config") {
          config = viewerConfig("none");
          setRuntimeConfigSnapshot(config);
        } else if (change === "identity") {
          client.authenticatedUserProfile = {
            ...client.authenticatedUserProfile!,
            profileId: owner,
          };
        } else {
          if (change === "membership-external") {
            const external = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
            try {
              external
                .prepare("DELETE FROM session_members WHERE session_key = ? AND identity_id = ?")
                .run(scope.sessionKey, viewer);
            } finally {
              external.close();
            }
            // External writers publish committed changes through their owning bridge.
            sessionChanges.emit({ ...scope, factsInvalidated: true });
          } else if (membershipChange) {
            expect(removeSessionMember(scope, viewer)).not.toBeNull();
          } else {
            replaceSessionEntrySync(scope, {
              ...selected,
              visibility: "draft",
            });
          }
          if (change === "membership" || change === "visibility") {
            emitSessionsChanged(context, { reason: "sharing", sessionKey: scope.sessionKey });
          }
        }
      });

      const result = await listSessions({
        client,
        context,
        request,
      });
      if (membershipChange) {
        expect(result.sessions).toMatchObject([
          { key: scope.sessionKey, sharingRole: "viewer", activitySummary: { canEnsure: false } },
        ]);
      } else {
        expect(result.sessions.map((session) => session.key)).toEqual([replacementKey]);
        expect(result).toMatchObject({ count: 1, nextOffset: 1 });
      }
    });
  },
);
