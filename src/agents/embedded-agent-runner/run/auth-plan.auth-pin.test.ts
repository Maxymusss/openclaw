import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { readModelRequestRoute } from "../../../llm/model-runtime-binding.js";
import type { Model } from "../../../llm/types.js";
import { registerSingleProviderPlugin } from "../../../plugin-sdk/plugin-test-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-operator-authority.js";
import { clearRuntimeAuthProfileStoreSnapshot, type OAuthCredential } from "../../auth-profiles.js";
import { testing as externalAuthTesting } from "../../auth-profiles/external-auth.test-support.js";
import { clearAuthProfileMigrationDiagnostics } from "../../auth-profiles/legacy-source-diagnostic.js";
import { writePersistedAuthProfileStoreRaw } from "../../auth-profiles/sqlite.js";
import type { AgentHarness } from "../../harness/types.js";
import * as modelAuth from "../../model-auth.js";
import { prepareOperatorModelPolicy } from "../../operator-model-policy.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import * as modelRuntime from "../model.js";
import { resolveRuntimeHooks, type ProviderRuntimeHooks } from "../model.provider-hooks.js";
import { prepareEmbeddedRunAuthPlan } from "./auth-plan.js";

const readCodexCliCredentialsCachedMock = vi.hoisted(() =>
  vi.fn<(_options?: unknown) => OAuthCredential | null>(() => null),
);

vi.mock("../../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
}));

const subscriptionModel: Model = {
  id: "gpt-5.6-luna",
  name: "Auth pin model",
  provider: "openai",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_024,
};
const platformModel: Model = {
  ...subscriptionModel,
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};

const openClawHarness: AgentHarness = {
  id: "openclaw",
  label: "OpenClaw fixture",
  supports: () => ({ supported: true }),
  runAttempt: async () => {
    throw new Error("Auth preparation must not execute a model turn");
  },
};

describe("embedded run auth plan provider pin", () => {
  let state: OpenClawTestState;
  let agentDir: string;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      prefix: "openclaw-auth-pin-",
      env: { OPENAI_API_KEY: "platform-api-key" },
    });
    agentDir = state.agentDir();
    readCodexCliCredentialsCachedMock.mockReset().mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "codex-access-token",
      refresh: "codex-refresh-token",
      expires: Date.now() + 30 * 60_000,
    });
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  });

  afterEach(async () => {
    clearAuthProfileMigrationDiagnostics();
    clearRuntimeAuthProfileStoreSnapshot(agentDir);
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
    readCodexCliCredentialsCachedMock.mockReset();
    vi.restoreAllMocks();
    await state.cleanup();
  });

  it("prepares a LiteLLM turn while Anthropic credentials await migration", async () => {
    await state.writeJson("agents/main/agent/auth-profiles.json", {
      version: 1,
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "legacy-key" },
      },
    });
    writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
    const model: Model = {
      ...platformModel,
      provider: "litellm",
      id: "chat",
      name: "Chat",
      api: "openai-completions",
      baseUrl: "https://litellm.example.test/v1",
    };
    const config: OpenClawConfig = {
      models: {
        providers: { litellm: { baseUrl: model.baseUrl, apiKey: "litellm-key", models: [] } },
      },
    };
    const stores = modelRuntime.createEmptyAgentDiscoveryStores();
    vi.spyOn(modelRuntime, "resolveModelAsync").mockResolvedValue({
      ...stores,
      model,
      logicalRef: { provider: model.provider, model: model.id },
    });
    const prepared = await withPluginRuntimeGenerationScope(
      { metadataSnapshot: createPluginMetadataSnapshotFixture() },
      () =>
        prepareEmbeddedRunAuthPlan({
          assertCurrent: () => {},
          runParams: {
            sessionId: "migration-session",
            runId: "migration-run",
            workspaceDir: state.workspaceDir,
            prompt: "Auth preparation only",
            timeoutMs: 5_000,
            config,
          },
          provider: "litellm",
          modelId: model.id,
          model,
          agentDir,
          workspaceDir: state.workspaceDir,
          nativeModelOwned: false,
          ...stores,
          getAgentHarness: () => openClawHarness,
          setAgentHarness: () => {},
          getRuntimeModel: () => model,
          getEffectiveModel: () => model,
          applyResolvedRuntimeModel: () => {},
          selectHarnessForPreparedAttempts: () => openClawHarness,
        }),
    );
    expect(prepared.preparedAuthAttempts[0]).toMatchObject({
      kind: "direct",
      plan: { providerForAuth: "litellm", selectedAuthMode: "api-key" },
    });
  });

  it.each([
    "mapped",
    "unbound",
    "forged-logical-ref",
    "copied-route",
    "source-revoked",
    "policy-narrowed",
  ] as const)(
    "validates the host-selected Arcee route around auth materialization: %s",
    async (mode) => {
      const plugin = await loadBundledPluginFacade<{
        default: Parameters<typeof registerSingleProviderPlugin>[0];
      }>({ pluginId: "arcee", artifactBasename: "index.js" });
      const provider = await registerSingleProviderPlugin(plugin.default);
      const logicalId = "trinity-large-thinking";
      const configured = makeProviderModelFixture<"openai-completions">({
        provider: "arcee",
        id: logicalId,
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
      });
      const config: OpenClawConfig = {
        models: {
          providers: {
            arcee: { api: configured.api, baseUrl: configured.baseUrl, models: [configured] },
          },
        },
      };
      const runtimeHooks: ProviderRuntimeHooks = {
        ...resolveRuntimeHooks({ skipProviderRuntimeHooks: true }),
        normalizeProviderResolvedModelWithPlugin: ({ context }) =>
          provider.normalizeResolvedModel?.(context),
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture();
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
        const resolve = modelRuntime.resolveModelAsync;
        const stores = modelRuntime.createEmptyAgentDiscoveryStores();
        const resolved = await resolve("arcee", logicalId, agentDir, config, {
          ...stores,
          skipAgentDiscovery: true,
          runtimeHooks,
        });
        if (!resolved.model) {
          throw new Error(resolved.error);
        }
        expect(resolved.model.id).toBe("arcee-ai/trinity-large-thinking");
        expect(readModelRequestRoute(resolved.model)?.logicalRef).toEqual({
          provider: "arcee",
          model: logicalId,
        });
        const unbound = makeProviderModelFixture({
          provider: resolved.model.provider,
          id: resolved.model.id,
          api: resolved.model.api,
          baseUrl: resolved.model.baseUrl,
        });
        const model =
          mode === "unbound"
            ? unbound
            : mode === "forged-logical-ref"
              ? { ...unbound, logicalRef: resolved.logicalRef }
              : mode === "copied-route"
                ? { ...resolved.model, id: "arcee-ai/trinity-large-preview" }
                : resolved.model;
        const initialDenial = ["unbound", "forged-logical-ref", "copied-route"].includes(mode);
        const entered = createDeferredCore();
        const finish = createDeferredCore();
        const cancelled = new AbortController();
        const release = vi.fn();
        let policy = prepareOperatorModelPolicy({
          cfg: config,
          policy: { allow: [`arcee/${logicalId}`] },
          manifestPlugins: [],
        });
        expect(policy?.allows({ provider: "arcee", model: resolved.model.id })).toBe(false);
        const authority = createAdmittedRunOperatorAuthority({
          profileId: "viewer",
          scopes: ["operator.write"],
          signal: cancelled.signal,
          assertCurrent() {},
          retain: () => release,
          get modelPolicy() {
            return policy;
          },
        });
        const admission = prepareAgentRunAdmission({
          cfg: config,
          facts: {
            runId: "mapped-auth",
            agentId: "main",
            ingress: { kind: "system", boundary: "test", state: "present" },
          },
          operationalRunInstance: createOperationalRunInstanceRef("mapped-auth"),
          operatorAuthority: authority,
        });
        writePersistedAuthProfileStoreRaw(
          {
            version: 1,
            profiles: {
              "arcee:selected": { type: "api_key", provider: "arcee", key: "fixture-key" },
            },
          },
          agentDir,
        );
        const readStore = vi.spyOn(modelAuth, "ensureAuthProfileStoreWithoutExternalProfiles");
        const resolver = vi
          .spyOn(modelRuntime, "resolveModelAsync")
          .mockImplementation(async (...args) => {
            entered.resolve();
            await finish.promise;
            return resolve(args[0], args[1], args[2], args[3], { ...args[4], runtimeHooks });
          });
        const applyModel = vi.fn();
        const harness = { ...openClawHarness, operatorModelPolicySupport: "exact" as const };
        const pending = prepareEmbeddedRunAuthPlan({
          assertCurrent() {},
          runParams: {
            config,
            preparedRunAdmission: admission,
            sessionId: "mapped-auth",
            runId: "mapped-auth",
            workspaceDir: state.workspaceDir,
            prompt: "Prepare only",
            timeoutMs: 5_000,
            authProfileId: "arcee:selected",
            authProfileIdSource: "user",
          },
          provider: "arcee",
          modelId: logicalId,
          model,
          agentDir,
          workspaceDir: state.workspaceDir,
          nativeModelOwned: false,
          ...stores,
          getAgentHarness: () => harness,
          setAgentHarness() {},
          getRuntimeModel: () => model,
          getEffectiveModel: () => model,
          applyResolvedRuntimeModel: applyModel,
          selectHarnessForPreparedAttempts: () => harness,
        });
        const checked =
          mode === "mapped"
            ? expect(pending).resolves.toMatchObject({ preferredProfileId: "arcee:selected" })
            : expect(pending).rejects.toMatchObject({ code: "OPERATOR_MODEL_POLICY_DENIED" });
        try {
          if (!initialDenial) {
            await Promise.race([
              entered.promise,
              pending.then(() => {
                throw new Error("Materializer hold missed");
              }),
            ]);
            expect(applyModel).not.toHaveBeenCalled();
            if (mode === "source-revoked") {
              cancelled.abort(new Error("source revoked"));
            }
            if (mode === "policy-narrowed") {
              policy = prepareOperatorModelPolicy({
                cfg: config,
                policy: { allow: [] },
                manifestPlugins: [],
              });
              expect(() => authority.assertCurrent()).not.toThrow();
            }
          }
          finish.resolve();
          await checked;
          expect(applyModel).toHaveBeenCalledTimes(mode === "mapped" ? 1 : 0);
          if (initialDenial) {
            expect(readStore).not.toHaveBeenCalled();
            expect(resolver).not.toHaveBeenCalled();
          } else {
            expect(readStore).toHaveBeenCalled();
            expect(resolver).toHaveBeenCalledOnce();
          }
        } finally {
          finish.resolve();
          await Promise.allSettled([pending, checked]);
          admission.close();
        }
        expect(release).toHaveBeenCalledOnce();
      });
    },
  );

  it.each([
    {
      allowAuthProfileFallback: undefined,
      configuredBackup: false,
      profileIds: ["openai:selected", "openai:backup"],
    },
    {
      allowAuthProfileFallback: false,
      configuredBackup: false,
      profileIds: ["openai:selected"],
    },
    {
      allowAuthProfileFallback: false,
      configuredBackup: true,
      profileIds: ["openai:selected"],
    },
  ])(
    "prepares permitted credentials with fallback=$allowAuthProfileFallback and configured backup=$configuredBackup",
    async ({ allowAuthProfileFallback, configuredBackup, profileIds }) => {
      readCodexCliCredentialsCachedMock.mockReturnValue(null);
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "openai:selected": { type: "api_key", provider: "openai", key: "selected-key" },
            "openai:backup": { type: "api_key", provider: "openai", key: "backup-key" },
          },
          order: { openai: ["openai:backup", "openai:selected"] },
        },
        agentDir,
      );
      const model = platformModel;
      const config: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: model.baseUrl,
              models: [],
              ...(configuredBackup
                ? { apiKey: { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" } }
                : {}),
            },
          },
        },
      };
      const stores = modelRuntime.createEmptyAgentDiscoveryStores();
      const resolution = {
        ...stores,
        model,
        logicalRef: { provider: model.provider, model: model.id },
      };
      vi.spyOn(modelRuntime, "resolveModelAsync").mockResolvedValue(resolution);
      const prepared = await withPluginRuntimeGenerationScope(
        { metadataSnapshot: createPluginMetadataSnapshotFixture() },
        () =>
          prepareEmbeddedRunAuthPlan({
            assertCurrent: () => {},
            runParams: {
              sessionId: "verify-session",
              runId: "verify-run",
              workspaceDir: state.workspaceDir,
              prompt: "Verify the selected credential",
              timeoutMs: 5_000,
              config,
              authProfileId: "openai:selected",
              authProfileIdSource: "user",
              allowAuthProfileFallback,
            },
            provider: "openai",
            modelId: model.id,
            model,
            agentDir,
            workspaceDir: state.workspaceDir,
            nativeModelOwned: false,
            ...stores,
            getAgentHarness: () => openClawHarness,
            setAgentHarness: () => {},
            getRuntimeModel: () => model,
            getEffectiveModel: () => model,
            applyResolvedRuntimeModel: () => {},
            selectHarnessForPreparedAttempts: () => openClawHarness,
          }),
      );

      expect(prepared.preparedAuthAttempts.map((attempt) => attempt.profileId)).toEqual(profileIds);
      expect(prepared.activePreparedAuthPlan.forwardedAuthProfileCandidateIds).toEqual(profileIds);
      expect(Object.keys(prepared.attemptAuthProfileStore.profiles).toSorted()).toEqual([
        "openai:backup",
        "openai:selected",
      ]);
    },
  );

  it.each([true, false])(
    "uses host API-key auth without importing Codex OAuth (pin=%s)",
    async (pin) => {
      const config: OpenClawConfig = {
        models: {
          providers: {
            openai: { ...(pin ? { auth: "api-key" as const } : {}), baseUrl: "", models: [] },
          },
        },
      };
      const stores = modelRuntime.createEmptyAgentDiscoveryStores();
      // Catalog discovery is peripheral; store loading, ambient overlay, auth selection,
      // and materialization of the selected transport all run through their real owners.
      vi.spyOn(modelRuntime, "resolveModelAsync").mockImplementation(
        async (_provider, _modelId, _agentDir, cfg) => ({
          ...stores,
          logicalRef: { provider: _provider, model: _modelId },
          model:
            cfg?.models?.providers?.openai?.api === "openai-responses"
              ? platformModel
              : subscriptionModel,
        }),
      );
      let model = subscriptionModel;
      let harness = openClawHarness;
      // A prepared generation owns plugin discovery; no provider runtime is needed here.
      const prepared = await withPluginRuntimeGenerationScope(
        { metadataSnapshot: createPluginMetadataSnapshotFixture() },
        () =>
          prepareEmbeddedRunAuthPlan({
            assertCurrent: () => {},
            runParams: {
              sessionId: "auth-pin-session",
              runId: "auth-pin-run",
              workspaceDir: state.workspaceDir,
              prompt: "Auth preparation only",
              timeoutMs: 5_000,
              config,
            },
            provider: "openai",
            modelId: model.id,
            model,
            agentDir,
            workspaceDir: state.workspaceDir,
            nativeModelOwned: false,
            ...stores,
            getAgentHarness: () => harness,
            setAgentHarness: (next) => {
              harness = next;
            },
            getRuntimeModel: () => model,
            getEffectiveModel: () => model,
            applyResolvedRuntimeModel: (next) => {
              model = next;
            },
            selectHarnessForPreparedAttempts: () => openClawHarness,
          }),
      );

      expect(prepared.preparedAuthAttempts[0]).toMatchObject({
        kind: "direct",
        plan: { selectedAuthMode: "api-key", modelRoute: { authRequirement: "api-key" } },
      });
      expect(prepared.attemptAuthProfileStore.profiles["openai:default"]).toBeUndefined();
      expect(readCodexCliCredentialsCachedMock).not.toHaveBeenCalled();
      expect(model).toEqual(platformModel);
    },
  );
});
