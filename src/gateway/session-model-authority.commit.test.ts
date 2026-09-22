import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { getRegisteredAgentHarness, registerAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarness } from "../agents/harness/types.js";
import { createModelRuntimeChoiceOwnerFixture } from "../agents/model-runtime-choice.test-support.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import * as modelRuntimeSelection from "../auto-reply/reply/model-runtime-normalization.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { createRuntimeTestRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { SessionCatalogProvider } from "../plugins/session-catalog.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "./methods/registry.js";
import type { OperatorScope } from "./operator-scopes.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { buildModelsListResult } from "./server-methods/models-list-result.js";
import { sessionCatalogHandlers } from "./server-methods/session-catalog.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import * as sessionModelSelection from "./server-methods/sessions-patch-model-selection.js";
import type { RespondFn } from "./server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "./server-model-catalog-auth.js";
import { readPreparedGatewayModelCatalogOwnerSnapshot } from "./server-model-catalog.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";
import { createGatewaySession } from "./session-create-service.js";
import type { PreparedGatewaySessionLifecycle } from "./session-lifecycle-preparation.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

const published = vi.hoisted(
  (): { owner?: PreparedModelRuntimeSnapshot; beforeOwnership?: () => void } => ({}),
);
const registries = new Set<ReturnType<typeof createRuntimeTestRegistry>["registry"]>();
afterEach(async () => {
  published.beforeOwnership = undefined;
  for (const registry of registries) {
    await disposePluginRegistryInstances(registry);
  }
  registries.clear();
});
vi.mock("../plugins/registry-runtime-session-ownership.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/registry-runtime-session-ownership.js")>();
  return {
    ...actual,
    createPluginSessionOwnership: (
      ...args: Parameters<typeof actual.createPluginSessionOwnership>
    ) => {
      published.beforeOwnership?.();
      return actual.createPluginSessionOwnership(...args);
    },
  };
});
vi.mock("../agents/prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-catalog.js")>()),
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
}));

function fixture(mode: string, scopes: OperatorScope[] = ["operator.sessions.write"]) {
  const client = roleClient("view", "model-selection-owner");
  client.connect.scopes = scopes;
  const profileId = client.authenticatedUserProfile!.profileId;
  const cfg = rolePolicyConfig();
  const role = expectDefined(cfg.gateway?.roles?.definitions.view, "selection role");
  role.scopes = scopes;
  if (mode !== "unrestricted") {
    role.models = { allow: ["fixture/allowed"] };
  }
  cfg.agents = {
    defaults: {
      model: "fixture/hidden",
      models: {
        "fixture/hidden": { agentRuntime: { id: "selection-runtime" } },
        "fixture/allowed": { agentRuntime: { id: "selection-runtime" } },
      },
    },
  };
  let active = true;
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId,
    scopes: client.connect.scopes,
    permissions: mode === "unrestricted" ? undefined : { models: { allow: ["fixture/allowed"] } },
    assertCurrent: () => {
      if (!active) {
        throw new Error("original model selection authority revoked");
      }
    },
  });
  client.internal = { ...client.internal, operatorRunAuthority: operatorAuthority };
  const harness: AgentHarness = {
    id: "selection-runtime",
    label: "Selection fixture",
    authBootstrap: "harness",
    ...(mode === "unsupported" || mode === "unrestricted"
      ? {}
      : { operatorModelPolicySupport: "exact" as const }),
    supports: () => ({ supported: true }),
    readModelCatalogReadiness: () => ({ accountType: "subscription", authMode: "oauth" }),
    async runAttempt() {
      throw new Error("Model selection must not start inference");
    },
  };
  const builder = createRuntimeTestRegistry(createPluginRuntime());
  const registry = builder.registry;
  registries.add(registry);
  const api = builder.createApi(
    createPluginRecord({ id: "selection-runtime", origin: "bundled" }),
    { config: cfg },
  );
  api.registerAgentHarness(harness);
  markPluginRegistryActive(registry);
  const entries = ["allowed", "hidden"].map((id) => ({
    provider: "fixture",
    id,
    name: id,
    reasoning: false,
    nativeRuntime: harness.id,
  }));
  const owner = createModelRuntimeChoiceOwnerFixture(cfg, () => true, {
    pluginRegistry: registry,
    modelCatalog: { entries, routeVariants: entries },
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "selection-runtime",
          origin: "bundled",
          providers: ["fixture"],
          activation: { onAgentHarnesses: ["selection-runtime"] },
        },
      ],
    }),
  });
  published.owner = owner;
  return {
    cfg,
    client,
    profileId,
    operatorAuthority,
    owner,
    registry,
    api,
    role,
    dispose: async () => {
      await disposePluginRegistryInstances(registry);
      registries.delete(registry);
    },
    catalog: {
      entries,
      routeVariants: entries,
      agentId: expectDefined(owner.agentId, "catalog owner agent"),
      agentDir: owner.agentDir,
      workspaceDir: expectDefined(owner.workspaceDir, "catalog owner workspace"),
      config: owner.config,
      catalogComplete: false,
    } satisfies GatewayModelCatalogSnapshot,
    revoke: () => {
      active = false;
    },
  };
}

describe("durable session model selection authority", () => {
  it.each(["allowed", "default-denied", "widened", "unrestricted"])(
    "binds scoped plugin session creation without a catalog intermediary: %s",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const f = fixture(mode, ["operator.write"]);
        if (mode === "allowed") {
          f.cfg.agents!.defaults!.model = "fixture/allowed";
        }
        await state.writeConfig(f.cfg);
        const scope = { agentId: "main", sessionKey: "agent:main:plugin-model" };
        delete f.client.internal!.operatorRunAuthority;
        if (mode === "widened") {
          published.beforeOwnership = () => {
            f.role.models = { allow: ["fixture/allowed", "fixture/hidden"] };
          };
        }
        const request = withPluginRuntimeGenerationScope(f.owner, () =>
          withPluginRuntimeGatewayRequestScope(
            {
              client: f.client,
              context: createDirectChatContext({ getRuntimeConfig: () => f.cfg }),
              isWebchatConnect: () => false,
              pluginRegistry: f.registry,
            },
            () =>
              f.api.runtime.agent.session.createSessionEntry({
                cfg: f.cfg,
                key: scope.sessionKey,
                agentId: scope.agentId,
                initialEntry: { agentHarnessId: "selection-runtime" },
              }),
          ),
        );
        try {
          if (mode === "default-denied" || mode === "widened") {
            await expect(request).rejects.toThrow("does not allow this model");
            expect(loadSessionEntry(scope)).toBeUndefined();
          } else {
            const created = await request;
            const stored = expectDefined(loadSessionEntry(scope), "plugin-created row");
            expect(stored.sessionId).toBe(created.sessionId);
            expect(resolveSessionModelRef(f.cfg, stored, "main")).toMatchObject({
              provider: "fixture",
              model: mode === "allowed" ? "allowed" : "hidden",
            });
          }
        } finally {
          published.owner = undefined;
          await f.dispose();
        }
      });
    },
  );

  it.each([
    ["copy", "allowed"],
    ["copy", "default-denied"],
    ["copy", "explicit-denied"],
    ["copy", "revoked"],
    ["copy", "widened"],
    ["copy", "unrestricted"],
    ["provider", "allowed"],
    ["provider", "default-denied"],
    ["provider", "revoked"],
    ["provider", "widened"],
    ["provider", "unrestricted"],
  ])("keeps catalog %s creation under its original %s authority", async (route, mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = fixture(mode, ["operator.admin"]);
      if (mode === "widened") {
        delete f.client.internal!.operatorRunAuthority;
      }
      if (mode === "allowed" || mode === "revoked" || mode === "explicit-denied") {
        f.cfg.agents!.defaults!.model = "fixture/allowed";
      }
      await state.writeConfig(f.cfg);
      const scope = { agentId: "main", sessionKey: "agent:main:catalog-model" };
      const entered = createDeferred();
      const release = createDeferred();
      const prepare = async () => {
        if (mode === "revoked" || mode === "widened") {
          entered.resolve();
          await release.promise;
        }
      };
      const provider: SessionCatalogProvider = {
        id: "model-catalog",
        label: "Model catalog",
        audience: "gateway-operators",
        list: vi.fn(async () => []),
        read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
        ...(route === "copy"
          ? {
              copyToGatewaySession: async () => {
                await prepare();
                return {
                  displayName: "Catalog copy",
                  ...(mode === "explicit-denied" ? { preferredModel: "fixture/hidden" } : {}),
                };
              },
            }
          : {
              continueSession: async () => {
                await prepare();
                const created = await f.api.runtime.agent.session.createSessionEntry({
                  cfg: f.cfg,
                  key: scope.sessionKey,
                  agentId: scope.agentId,
                  initialEntry: { agentHarnessId: "selection-runtime" },
                });
                return { sessionKey: created.key };
              },
            }),
      };
      f.registry.sessionCatalogs.push({
        pluginId: "selection-runtime",
        source: "fixture",
        provider,
      });
      markPluginRegistryActive(f.registry);
      const projection = createSessionRowProjectionFixture({ cfg: f.cfg, store: {} });
      const context = bindSessionRowProjection(
        createDirectChatContext({
          getRuntimeConfig: () => f.cfg,
          loadGatewayModelCatalogSnapshot: async () => f.catalog,
        }),
        () => projection,
      );
      const readPrepared = () =>
        readPreparedGatewayModelCatalogOwnerSnapshot({ agentId: "main", getConfig: () => f.cfg });
      const loadDeferred = vi.fn(async () =>
        expectDefined(await readPrepared(), "published catalog owner"),
      );
      registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
        readPrepared,
        loadDeferred,
      });
      const respond = vi.fn<RespondFn>();
      const request = withPluginRuntimeGenerationScope(f.owner, () =>
        withPluginRuntimeRegistryScope(f.registry, async () => {
          if (route === "copy" && mode === "explicit-denied") {
            const catalog = await buildModelsListResult({
              source: { kind: "gateway", context },
              agentId: "main",
              params: { view: "all" },
            });
            expect(catalog.models).toContainEqual(
              expect.objectContaining({ provider: "fixture", id: "hidden", available: true }),
            );
          }
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "model-catalog",
              method: "sessions.catalog.continue",
              params: {
                catalogId: provider.id,
                hostId: "gateway",
                threadId: "source",
                agentId: "main",
              },
            },
            client: f.client,
            context,
            respond,
            isWebchatConnect: () => false,
            methodRegistry: createGatewayMethodRegistry(
              createCoreGatewayMethodDescriptors(sessionCatalogHandlers),
              f.registry,
            ),
          });
        }),
      );
      try {
        if (mode === "revoked" || mode === "widened") {
          expect(
            await Promise.race([entered.promise.then(() => true), request.then(() => false)]),
          ).toBe(true);
          expect(listSessionEntriesCore({ agentId: "main" })).toEqual([]);
          if (mode === "widened") {
            f.role.models = { allow: ["fixture/allowed", "fixture/hidden"] };
          } else {
            f.revoke();
          }
          release.resolve();
        }
        await request;
        expect(loadDeferred).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledOnce();
        const rows = listSessionEntriesCore({ agentId: "main" });
        if (mode === "allowed" || mode === "unrestricted") {
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          expect(rows).toHaveLength(1);
          expect(respond.mock.calls[0]?.[1]).toEqual({ sessionKey: rows[0]?.sessionKey });
          expect(rows[0]?.entry.sessionId).toEqual(expect.any(String));
          const row = expectDefined(rows[0], "catalog-created row");
          expect(resolveSessionModelRef(f.cfg, row.entry, "main")).toMatchObject({
            provider: "fixture",
            model: mode === "allowed" ? "allowed" : "hidden",
          });
          if (route === "copy") {
            expect(provider.read).toHaveBeenCalledOnce();
          }
        } else {
          expect(respond.mock.calls[0]?.[0]).toBe(false);
          expect(respond.mock.calls[0]?.[1]).toBeUndefined();
          if (mode === "revoked") {
            expect(respond.mock.calls[0]?.[2]?.message).toBe(
              "original model selection authority revoked",
            );
          } else {
            expect(respond.mock.calls[0]?.[2]?.message).toContain("does not allow this model");
          }
          expect(rows).toEqual([]);
          expect(provider.read).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await request.catch(() => {});
        projection.dispose();
        published.owner = undefined;
        await f.dispose();
      }
    });
  });

  it.each(["allowed", "default-denied", "explicit-denied", "unsupported", "unrestricted"])(
    "creates a session only for an admitted %s selection",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const f = fixture(mode);
        const scope = { agentId: "main", sessionKey: "agent:main:model-create" };
        try {
          const result = await withPluginRuntimeGenerationScope(f.owner, () =>
            createGatewaySession({
              cfg: f.cfg,
              key: scope.sessionKey,
              commandSource: "test",
              operatorRoleActor: { kind: "operator", profileId: f.profileId },
              requestingOperatorScopes: f.client.connect.scopes,
              requestingOperatorProfileId: f.profileId,
              operatorAuthority: f.operatorAuthority,
              creation: {
                via: "operator",
                actor: { type: "human", source: "profile", id: f.profileId },
              },
              ...(mode === "default-denied"
                ? {}
                : { model: mode === "explicit-denied" ? "fixture/hidden" : "fixture/allowed" }),
              loadGatewayModelCatalogSnapshot: async () => f.catalog,
            }),
          );
          if (mode === "allowed" || mode === "unrestricted") {
            expect(result).toMatchObject({ ok: true, postCommit: { status: "completed" } });
            expect(loadSessionEntry(scope)).toMatchObject({
              providerOverride: "fixture",
              modelOverride: "allowed",
              agentRuntimeOverride: "selection-runtime",
              createdActor: { type: "human", source: "profile", id: f.profileId },
            });
          } else {
            expect(result).toMatchObject({
              ok: false,
              error: {
                code: "FORBIDDEN",
                message: expect.stringContaining(
                  mode === "unsupported" ? "cannot enforce" : "does not allow this model",
                ),
              },
            });
            expect(loadSessionEntry(scope)).toBeUndefined();
          }
        } finally {
          published.owner = undefined;
          await f.dispose();
        }
      });
    },
  );

  it("rejects source revocation after runtime preparation and before creation COMMIT", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture("allowed");
      const scope = { agentId: "main", sessionKey: "agent:main:model-create-revoked" };
      const entered = createDeferred();
      const release = createDeferred();
      const committed = vi.fn();
      const withCommit: NonNullable<PreparedGatewaySessionLifecycle["withCommit"]> = async (
        run,
      ) => {
        entered.resolve();
        await release.promise;
        return await run(() => {});
      };
      const request = withPluginRuntimeGenerationScope(f.owner, () =>
        createGatewaySession({
          cfg: f.cfg,
          key: scope.sessionKey,
          model: "fixture/allowed",
          commandSource: "test",
          operatorRoleActor: { kind: "operator", profileId: f.profileId },
          operatorAuthority: f.operatorAuthority,
          requestingOperatorScopes: f.client.connect.scopes,
          loadGatewayModelCatalogSnapshot: async () => f.catalog,
          prepareLifecycle: async () => ({
            ok: true,
            value: { withCommit },
          }),
          onCreatedSessionCommitted: committed,
        }),
      );
      try {
        expect(
          await Promise.race([entered.promise.then(() => true), request.then(() => false)]),
        ).toBe(true);
        expect(loadSessionEntry(scope)).toBeUndefined();
        f.revoke();
        const rejected = expect(request).rejects.toThrow(
          "operator execution authority is no longer active",
        );
        release.resolve();
        await rejected;
        expect(committed).not.toHaveBeenCalled();
        expect(loadSessionEntry(scope)).toBeUndefined();
      } finally {
        release.resolve();
        await request.catch(() => {});
        published.owner = undefined;
        await f.dispose();
      }
    });
  });

  it.each([
    "allowed",
    "explicit-denied",
    "unsupported",
    "revoked",
    "unrestricted",
    "repin-allowed",
    "repin-replaced",
    "repin-retired",
    "repin-revoked",
  ])("patches the exact stored generation only for an admitted %s selection", async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture(mode);
      const repin = mode.startsWith("repin-");
      const scope = { agentId: "main", sessionKey: "agent:main:model-patch" };
      const original = {
        sessionId: "selection-generation",
        updatedAt: 1,
        providerOverride: "fixture",
        modelOverride: repin ? "allowed" : "hidden",
        ...(repin
          ? {
              authProfileOverride: "fixture:selected",
              agentRuntimeOverride: "selection-runtime",
            }
          : {}),
        createdActor: { type: "human" as const, source: "profile" as const, id: f.profileId },
      };
      await upsertSessionEntryCore(scope, original);
      const storedOriginal = expectDefined(loadSessionEntry(scope), "original stored generation");
      const catalogRead = vi.fn(async () => {
        if (mode === "revoked" || mode === "widened") {
          f.revoke();
        }
        return f.catalog;
      });
      const respond = vi.fn<RespondFn>();
      const prepareRuntime = repin
        ? vi.spyOn(modelRuntimeSelection, "prepareModelSelectionRuntime")
        : undefined;
      const prepareSelection = sessionModelSelection.prepareSessionPatchRuntimeSelection;
      const selection = repin
        ? vi
            .spyOn(sessionModelSelection, "prepareSessionPatchRuntimeSelection")
            .mockImplementation(async (params) => {
              const result = await prepareSelection(params);
              expect(result.ok).toBe(true);
              if (!result.ok) {
                throw new Error("Expected the finite-policy repin to prepare successfully");
              }
              expect(expectDefined(result.validate, "repin COMMIT validator")()).toBeUndefined();
              expect(params.operatorAuthority?.permissions?.models).toEqual({
                allow: ["fixture/allowed"],
              });
              expect(params.entry.agentRuntimeOverride).toBe("selection-runtime");
              expect(loadSessionEntry(scope)).toEqual(storedOriginal);
              const retained = expectDefined(
                getRegisteredAgentHarness("selection-runtime"),
                "retained runtime",
              );
              // Change the owner only after real preparation; the SQLite COMMIT must recheck it.
              if (mode === "repin-replaced") {
                registerAgentHarness(
                  { ...retained.harness },
                  { ownerPluginId: retained.ownerPluginId },
                );
                const replacement = expectDefined(
                  getRegisteredAgentHarness("selection-runtime"),
                  "replacement runtime",
                );
                expect(replacement.harness).not.toBe(retained.harness);
                expect(replacement.harness.operatorModelPolicySupport).toBe("exact");
              } else if (mode === "repin-retired") {
                markPluginRegistryRetired(f.registry);
                expect(getRegisteredAgentHarness("selection-runtime")).toBeUndefined();
              } else if (mode === "repin-revoked") {
                f.revoke();
              }
              return result;
            })
        : undefined;
      try {
        await withPluginRuntimeGenerationScope(f.owner, () =>
          handleGatewayRequest({
            req: {
              type: "req",
              id: "model-patch",
              method: "sessions.patch",
              params: {
                key: scope.sessionKey,
                expectedSessionId: original.sessionId,
                model: repin
                  ? "fixture/allowed@fixture:selected"
                  : mode === "explicit-denied"
                    ? "fixture/hidden"
                    : "fixture/allowed",
              },
            },
            context: createDirectChatContext({
              getRuntimeConfig: () => f.cfg,
              loadGatewayModelCatalogSnapshot: catalogRead,
            }),
            client: f.client,
            respond,
            isWebchatConnect: () => false,
            methodRegistry: createGatewayMethodRegistry(
              createCoreGatewayMethodDescriptors(sessionMutationHandlers),
              f.registry,
            ),
          }),
        );
        expect(catalogRead).toHaveBeenCalled();
        if (repin) {
          expect(selection).toHaveBeenCalledOnce();
          expect(prepareRuntime).not.toHaveBeenCalled();
          expect(f.role.models).toEqual({ allow: ["fixture/allowed"] });
        }
        if (mode === "allowed" || mode === "unrestricted" || mode === "repin-allowed") {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              ok: true,
              resolved: expect.objectContaining({
                modelProvider: "fixture",
                model: "allowed",
                agentRuntime: { id: "selection-runtime", source: "session-key" },
              }),
            }),
            undefined,
          );
          expect(loadSessionEntry(scope)).toMatchObject({
            sessionId: original.sessionId,
            providerOverride: "fixture",
            modelOverride: "allowed",
            agentRuntimeOverride: "selection-runtime",
            ...(repin ? { authProfileOverride: "fixture:selected" } : {}),
          });
        } else {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code:
                mode === "repin-replaced" || mode === "repin-retired"
                  ? "INVALID_REQUEST"
                  : "FORBIDDEN",
              message: expect.stringContaining(
                mode === "repin-replaced" || mode === "repin-retired"
                  ? "Runtime owner changed during selection"
                  : mode === "revoked" || mode === "repin-revoked"
                    ? "original model selection authority revoked"
                    : mode === "unsupported"
                      ? "cannot enforce"
                      : "does not allow this model",
              ),
            }),
          );
          expect(loadSessionEntry(scope)).toEqual(storedOriginal);
        }
      } finally {
        selection?.mockRestore();
        prepareRuntime?.mockRestore();
        published.owner = undefined;
        await f.dispose();
      }
    });
  });
});
