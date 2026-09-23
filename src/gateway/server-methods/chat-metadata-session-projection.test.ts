import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { createPreparedModelRequestBindingReader } from "../../agents/prepared-model-request-binding.js";
import { setPreparedModelFullCatalogAuth } from "../../agents/prepared-model-runtime-auth.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { Model } from "../../llm/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { modelCatalogRequestBindingSupported } from "../model-catalog-request-binding.js";
import { captureOperatorModelCatalogAccess } from "../operator-model-catalog.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";
import { prepareChatMetadataModelProjection } from "./chat-metadata-session-projection.js";

it("checks the requesting authority before materializing a captured executable catalog", async () => {
  const config = { agents: { list: [{ id: "main", default: true }] } };
  const base = createChatMetadataOwner(config, "allowed", {}, "fixture", "openai-completions");
  const createStores = vi.fn(() => {
    throw new Error("Revoked metadata must not materialize credentials");
  });
  const refusal = new Error("original requester revoked");
  const model = makeProviderModelFixture<"openai-completions">({
    provider: "fixture",
    id: "allowed",
    api: "openai-completions",
    baseUrl: "https://first.example/v1",
  });
  await expect(
    prepareChatMetadataModelProjection({
      context: {
        getRuntimeConfig: () => config,
        loadGatewayModelCatalogSnapshot: async () => {
          throw new Error("No discovery");
        },
        logGateway: { debug() {} },
      },
      facts: {
        agentId: "main",
        owner: { ...base, createStores },
        modelCatalog: base.modelCatalog,
        authStore: { version: 1, profiles: {} },
        authModes: {},
        publishedModels: new Map([[model.provider, [model]]]),
      },
      assertCurrent: () => {
        throw refusal;
      },
    }),
  ).rejects.toBe(refusal);
  expect(createStores).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps finite preloaded metadata on its published model snapshot (saved=%s)",
  async (saved) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const previousRegistry = captureActivePluginRegistrySnapshot();
      const pluginRegistry = createEmptyPluginRegistry();
      setActivePluginRegistry(pluginRegistry);
      try {
        registerAgentHarness({
          id: "fixture-supported",
          label: "Qualified fixture",
          operatorModelPolicySupport: "exact",
          supports: () => ({ supported: true }),
          async runAttempt() {
            throw new Error("Metadata must not execute inference");
          },
        });
        const cfg = rolePolicyConfig();
        const role = expectDefined(cfg.gateway?.roles?.definitions.view, "view role");
        role.scopes = ["operator.sessions.read"];
        role.modelPolicy = { allow: ["fixture/allowed"] };
        const model = makeProviderModelFixture<"openai-completions">({
          provider: "fixture",
          id: "allowed",
          api: "openai-completions",
          baseUrl: "https://first.example/v1",
        });
        cfg.agents = {
          defaults: {
            model: { primary: "fixture/allowed" },
            models: {
              "fixture/allowed": {
                agentRuntime: { id: "fixture-supported" },
                params: { transport: "sse" },
              },
            },
          },
          list: [{ id: "main", default: true }],
        };
        cfg.models = {
          mode: "replace",
          providers: {
            fixture: { api: "openai-completions", baseUrl: model.baseUrl, models: [model] },
          },
        };
        setRuntimeConfigSnapshot(cfg);
        const base = createChatMetadataOwner(
          cfg,
          model.id,
          { fixture: { type: "api_key", key: "fixture-key" } },
          model.provider,
          model.api,
        );
        const authStore = {
          version: 1,
          profiles: {
            "fixture:prepared": {
              type: "api_key" as const,
              provider: "fixture",
              key: "fixture-key",
            },
          },
        };
        const authStorage = AuthStorage.inMemory({});
        const registry = ModelRegistry.create(authStorage, "/unused/models.json", {
          config: cfg,
          modelsJsonContents: null,
          includePluginCatalogs: false,
          pluginMetadataSnapshot: base.metadataSnapshot,
        });
        let active = true;
        let publishedModels: ReadonlyMap<string, readonly Model[]> | undefined;
        let publishedCatalog: ModelCatalogSnapshot | undefined;
        const createStores = vi.fn(() => ({
          authStorage,
          modelRegistry: registry.fork(authStorage),
        }));
        const owner = {
          ...base,
          pluginRegistry,
          modelCatalog: { entries: [model], routeVariants: [model] },
          isCurrent: () => active,
          readPublishedModels: () => publishedModels,
          readPublishedModelCatalog: () => publishedCatalog,
          readFullModelCatalog: () => publishedCatalog,
          createStores,
        };
        const loadFullModelCatalog = vi.fn(async () => {
          throw new Error("Metadata must not discover providers");
        });
        const harness = createChatMetadataHarness(cfg, { useDefaultProjection: true });
        harness.setOwner({
          ...owner,
          readModelRequestBinding: createPreparedModelRequestBindingReader(owner, registry),
          loadFullModelCatalog,
        });
        harness.setAuthStore(authStore);
        const client = roleClient("view", "metadata-reader");
        client.connect.scopes = ["operator.sessions.read"];
        const access = captureOperatorModelCatalogAccess({
          client,
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        });
        const request = {
          agentId: "main",
          ...(saved
            ? {
                sessionKey: "agent:main:metadata",
                sessionEntry: {
                  authProfileOverride: "fixture:prepared",
                  authProfileOverrideSource: "user" as const,
                },
              }
            : {}),
        };
        const publish = (next: Model<"openai-completions" | "anthropic-messages">) => {
          publishedModels = new Map([[next.provider, [next]]]);
          publishedCatalog = { entries: [next], routeVariants: [next] };
          setPreparedModelFullCatalogAuth(
            expectDefined(publishedCatalog, "published model catalog"),
            {
              authStore,
              authModes: base.authModes,
              providerAuthLabels: new Map(),
            },
          );
        };
        try {
          await harness.runtime.refresh();
          const original = await harness.runtime.read(request);
          const originalChoice = expectDefined(original.models?.[0], "original model choice");
          expect(originalChoice).toMatchObject({
            id: model.id,
            agentRuntime: { id: "fixture-supported" },
            available: true,
          });
          expect(modelCatalogRequestBindingSupported(originalChoice)).toBe(true);
          expect(access.projectMetadata(original).models?.[0]?.available).toBe(true);
          expect(createStores).not.toHaveBeenCalled();

          publish({ ...model, api: "anthropic-messages", baseUrl: "https://second.example/v1" });
          await harness.runtime.refresh();
          const replacement = await harness.runtime.read(request);
          const replacementChoice = expectDefined(
            replacement.models?.[0],
            "replacement model choice",
          );
          expect(modelCatalogRequestBindingSupported(replacementChoice)).toBe(false);
          expect(access.projectMetadata(replacement).models?.[0]).toMatchObject({
            available: false,
            unavailableReason: "unsupported-runtime",
          });
          expect(modelCatalogRequestBindingSupported(originalChoice)).toBe(true);
          expect(createStores).toHaveBeenCalledOnce();
          await harness.runtime.read(request);
          expect(createStores).toHaveBeenCalledOnce();

          publish({ ...model, baseUrl: "https://third.example/v1" });
          await harness.runtime.refresh();
          const renewed = await harness.runtime.read(request);
          expect(
            modelCatalogRequestBindingSupported(
              expectDefined(renewed.models?.[0], "renewed model choice"),
            ),
          ).toBe(true);
          expect(access.projectMetadata(renewed).models?.[0]?.available).toBe(true);
          expect(modelCatalogRequestBindingSupported(replacementChoice)).toBe(false);
          active = false;
          expect(modelCatalogRequestBindingSupported(originalChoice)).toBe(false);
          expect(
            modelCatalogRequestBindingSupported(
              expectDefined(renewed.models?.[0], "retired model choice"),
            ),
          ).toBe(false);
          await expect(harness.runtime.read(request)).rejects.toThrow(/retired|unavailable/);
          expect(loadFullModelCatalog).not.toHaveBeenCalled();
          expect(registry.find(model.provider, model.id)).toMatchObject({
            api: model.api,
            baseUrl: model.baseUrl,
          });
        } finally {
          try {
            await harness.runtime.stop();
          } finally {
            access.release();
          }
        }
      } finally {
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    });
  },
);
