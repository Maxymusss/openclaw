import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { bindModelRequestRoute } from "../../llm/model-runtime-binding.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-operator-authority.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../auth-profiles/credential-fixtures.test-support.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "../embedded-agent-runner/model.generation-scope.test-support.js";
import {
  prepareOperatorModelPolicy,
  runWithOperatorModelAuthority,
} from "../operator-model-policy.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { maybeCompactAgentHarnessSession } from "./compaction.js";
import { clearAgentHarnesses, registerAgentHarness } from "./registry.js";
import type { AgentHarness } from "./types.js";

const compactAuthMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  getApiKeyForModelCore: vi.fn(),
  prepareAgentRuntimeAuth: vi.fn(),
  resolveModelAsync: vi.fn(),
}));
vi.mock("../model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-auth.js")>()),
  applySecretRefHeaderSentinels: (model: unknown) => model,
  ensureAuthProfileStore: compactAuthMocks.ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles:
    compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles,
  getApiKeyForModelCore: compactAuthMocks.getApiKeyForModelCore,
}));
vi.mock("../embedded-agent-runner/model.js", () => ({
  resolveModelAsync: compactAuthMocks.resolveModelAsync,
}));
vi.mock("../runtime-plan/prepare-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-plan/prepare-auth.js")>()),
  prepareAgentRuntimeAuth: compactAuthMocks.prepareAgentRuntimeAuth,
}));
vi.mock("../../plugins/providers.js", () => ({
  resolveProviderRefOwnership: () => ({ status: "unowned" }),
}));

let state: OpenClawTestState;
let generation: ReturnType<typeof createModelGenerationFixture>;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "compaction-cancel", applyEnv: false });
  resetModelGenerationFixtureState();
  generation = createModelGenerationFixture({
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    config: {},
    label: "compaction-cancel",
  });
  publishCurrentModelGeneration(generation);
});

afterEach(async () => {
  clearAgentHarnesses();
  resetModelGenerationFixtureState();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.resetAllMocks();
  await state.cleanup();
});

describe("harness compaction cancellation", () => {
  it.each(["mapped", "unbound", "mutated", "revoked", "narrowed", "staff"] as const)(
    "keeps logical selection through harness auth (%s)",
    async (mode) => {
      const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
        ok: true,
        compacted: false,
      }));
      registerAgentHarness({
        id: "mapping-fixture",
        label: "Mapped compaction fixture",
        supports: () => ({ supported: true, priority: 100 }),
        operatorModelPolicySupport: "exact",
        nativeModelPolicySupport: "exact",
        runAttempt: async () => {
          throw new Error("Unexpected inference");
        },
        compact,
      });
      const physical = makeProviderModelFixture({
        provider: "compaction-fixture",
        id: "wire-model",
        api: "openai-completions",
        baseUrl: "https://compaction.example/v1",
      });
      const mapped = bindModelRequestRoute(physical, {
        provider: physical.provider,
        model: "selected",
      });
      const model =
        mode === "unbound" ? physical : mode === "mutated" ? { ...mapped, id: "other" } : mapped;
      const source = new AbortController();
      let policy = prepareOperatorModelPolicy({
        cfg: {},
        policy: { allow: ["compaction-fixture/selected", "compaction-fixture/other"] },
        manifestPlugins: [],
      });
      const released = vi.fn();
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "compaction-owner",
        scopes: ["operator.sessions.write"],
        signal: source.signal,
        assertCurrent: () => source.signal.throwIfAborted(),
        retain: () => released,
        get modelPolicy() {
          return mode === "staff" ? undefined : policy;
        },
      });
      compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
        version: 1,
        profiles: {},
      });
      const plan = {
        providerForAuth: physical.provider,
        authProfileProviderForAuth: physical.provider,
        selectedAuthMode: "api_key" as const,
      };
      compactAuthMocks.prepareAgentRuntimeAuth.mockReturnValue({
        plan,
        attempts: [{ kind: "direct", plan }],
      });
      const entered = createDeferred();
      const proceed = createDeferred();
      compactAuthMocks.getApiKeyForModelCore.mockImplementation(async () => {
        entered.resolve();
        await proceed.promise;
        return { apiKey: "fixture-key", mode: "api-key", source: "fixture" };
      });
      const parent = new AsyncWorkScope();
      const pending = parent.run(() =>
        runWithOperatorModelAuthority(authority, () =>
          maybeCompactAgentHarnessSession(
            {
              sessionId: "mapped",
              sessionKey: "agent:main:mapped",
              sessionFile: state.path("mapped.jsonl"),
              workspaceDir: state.workspaceDir,
              agentDir: state.agentDir(),
              config: {},
              provider: physical.provider,
              model: "selected",
              runtimeModel: model,
              agentHarnessId: "mapping-fixture",
              operatorAuthority: authority,
            },
            { preparedModelRuntime: generation.preparedModelRuntime },
          ),
        ),
      );
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        if (mode !== "unbound" && mode !== "mutated") {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Harness auth hold missed");
            }),
          ]);
          expect(compact).not.toHaveBeenCalled();
          expect(released).not.toHaveBeenCalled();
          if (mode === "revoked") {
            source.abort(new Error("original harness source revoked"));
          }
          if (mode === "narrowed") {
            policy = prepareOperatorModelPolicy({
              cfg: {},
              policy: { allow: [] },
              manifestPlugins: [],
            });
          }
        }
        proceed.resolve();
        const result = await outcome;
        if (mode === "mapped" || mode === "staff") {
          expect(result).toMatchObject({ value: { ok: true } });
          expect(compact).toHaveBeenCalledTimes(1);
          expect(compact.mock.calls[0]?.[0].runtimeModel).toEqual(model);
        } else {
          expect(result).toHaveProperty("error");
          expect(compact).not.toHaveBeenCalled();
          if (mode === "unbound" || mode === "mutated") {
            expect(compactAuthMocks.getApiKeyForModelCore).not.toHaveBeenCalled();
          }
        }
      } finally {
        proceed.resolve();
        await outcome;
        await AsyncWorkScope.runWhenAllIdle(
          () => [parent],
          () => parent.drain(),
        );
      }
      expect(released).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["initial model lookup", "auth-route rematerialization"])(
    "does not start harness compaction when %s is cancelled",
    async (stage) => {
      const controller = new AbortController();
      const cancelled = new Error("Compaction model preparation cancelled");
      const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
        ok: true,
        compacted: false,
      }));
      registerAgentHarness(
        {
          id: "copilot",
          label: "Compaction cancellation fixture",
          supports: () => ({ supported: true, priority: 100 }),
          runAttempt: async () => {
            throw new Error("Compaction must not start inference");
          },
          compact,
        },
        { ownerPluginId: "copilot" },
      );
      if (stage === "auth-route rematerialization") {
        compactAuthMocks.resolveModelAsync.mockResolvedValueOnce({
          model: {
            id: "proxy-model",
            provider: "local-proxy",
            api: "openai-responses",
            baseUrl: "https://proxy.example/v1",
          },
        });
        compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
          createAuthProfileStoreFixture({
            "local-proxy:stale": createApiKeyCredential("local-proxy", "stale-key"),
          }),
        );
        const directPlan = {
          providerForAuth: "local-proxy",
          authProfileProviderForAuth: "local-proxy",
          selectedAuthMode: "api_key" as const,
        };
        const profilePlan = {
          ...directPlan,
          forwardedAuthProfileId: "local-proxy:stale",
          forwardedAuthProfileSource: "auto" as const,
        };
        compactAuthMocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
          plan: profilePlan,
          attempts: [
            {
              kind: "profile" as const,
              profileId: "local-proxy:stale",
              plan: profilePlan,
              allowAuthProfileFallback: false,
            },
            { kind: "direct" as const, plan: directPlan, requiresPriorProfileAttempt: true },
          ],
        });
        compactAuthMocks.getApiKeyForModelCore.mockRejectedValueOnce(new Error("stale profile"));
      }
      compactAuthMocks.resolveModelAsync.mockImplementationOnce(async () => {
        controller.abort(cancelled);
        throw cancelled;
      });

      await expect(
        maybeCompactAgentHarnessSession(
          {
            sessionId: "session-1",
            sessionKey: "agent:main:main",
            sessionFile: state.path("session.jsonl"),
            workspaceDir: state.workspaceDir,
            agentDir: state.agentDir(),
            config: {},
            provider: "local-proxy",
            model: "proxy-model",
            agentHarnessId: "copilot",
            abortSignal: controller.signal,
          },
          { preparedModelRuntime: generation.preparedModelRuntime },
        ),
      ).rejects.toBe(cancelled);
      expect(compact).not.toHaveBeenCalled();
    },
  );
});
