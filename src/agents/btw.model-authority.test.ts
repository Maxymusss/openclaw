import "./btw.mocks.test-support.js";
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { bindModelRequestRoute, readModelRequestRoute } from "../llm/model-runtime-binding.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.js";
import {
  DEFAULT_AGENT_DIR,
  closeAgentHarnessHostCapabilitiesMock,
  discoverAuthStorageMock,
  discoverModelsMock,
  ensureAuthProfileStoreWithoutExternalProfilesMock,
  ensureSelectedAgentHarnessPluginMock,
  getApiKeyForModelMock,
  prepareProviderRuntimeAuthMock,
  registerAgentHarness,
  registerProviderStreamForModelMock,
  resolveEmbeddedAgentStreamMock,
  resolveModelAsyncMock,
  resolveSessionAuthSelectionMock,
  runSideQuestion,
  setupBtwTestHooks,
  snapshotResources,
} from "./btw.test-support.js";
import type { AgentHarness } from "./harness/types.js";
import {
  captureOperatorModelRequest,
  prepareOperatorModelPolicy,
} from "./operator-model-policy.js";
import type { StreamFn } from "./runtime/index.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const { resolveEmbeddedAgentStream } = await vi.importActual<
  typeof import("./embedded-agent-runner/stream-resolution.js")
>("./embedded-agent-runner/stream-resolution.js");

function mappedModel(id = "wire-model", logicalId = "selected") {
  return bindModelRequestRoute(
    makeProviderModelFixture({
      provider: "btw-policy",
      id,
      api: "openai-completions",
      baseUrl: "https://btw.example/v1",
    }),
    { provider: "btw-policy", model: logicalId },
  );
}

function operatorSource(unrestricted = false) {
  const cancellation = new AbortController();
  let policy = prepareOperatorModelPolicy({
    cfg: {},
    policy: { allow: ["btw-policy/selected", "btw-policy/other"] },
    manifestPlugins: [],
  });
  const releases: ReturnType<typeof vi.fn>[] = [];
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "btw-owner",
    scopes: ["operator.sessions.write"],
    signal: cancellation.signal,
    assertCurrent: () => cancellation.signal.throwIfAborted(),
    get modelPolicy() {
      return unrestricted ? undefined : policy;
    },
    retain: () => {
      const release = vi.fn();
      releases.push(release);
      return release;
    },
  });
  return {
    authority,
    cancellation,
    releases,
    narrow: () => {
      policy = prepareOperatorModelPolicy({ cfg: {}, policy: { allow: [] }, manifestPlugins: [] });
    },
  };
}

function installHarness(sideQuestion?: AgentHarness["runSideQuestion"]) {
  registerAgentHarness({
    id: "btw-policy-fixture",
    label: "BTW policy fixture",
    supports: () => ({ supported: true, priority: 100 }),
    operatorModelPolicySupport: "exact",
    nativeModelPolicySupport: "exact",
    runAttempt: vi.fn(),
    ...(sideQuestion ? { runSideQuestion: sideQuestion } : {}),
  });
}

function installProvider() {
  const provider = vi.fn<StreamFn>((model) => {
    captureOperatorModelRequest(model)?.bindWireModel(model.id, model)(model, model.id);
    const result = createAssistantMessageEventStream();
    result.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        provider: model.provider,
        model: model.id,
        api: model.api,
        content: [{ type: "text", text: "Mapped answer" }],
        stopReason: "stop",
        timestamp: 1,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
    result.end();
    return result;
  });
  Object.assign(provider, { modelRequestBinding: "wire-model-v1" as const });
  registerProviderStreamForModelMock.mockReturnValue(provider);
  resolveEmbeddedAgentStreamMock.mockImplementation(resolveEmbeddedAgentStream);
  return provider;
}

describe("BTW mapped model authority", () => {
  setupBtwTestHooks();
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "mapped",
    "cached",
    "unbound",
    "mutated",
    "initial-denied",
    "source-revoked",
    "policy-narrowed",
    "late-rebound",
    "staff",
  ] as const)("checks the actual installed stream and original selection (%s)", async (mode) => {
    installHarness();
    const mapped = mode === "cached" ? mappedModel("selected") : mappedModel();
    const model =
      mode === "unbound"
        ? makeProviderModelFixture({
            provider: mapped.provider,
            id: mapped.id,
            api: mapped.api,
            baseUrl: mapped.baseUrl,
          })
        : mode === "mutated"
          ? { ...mapped, id: "other" }
          : mapped;
    const original = operatorSource(mode === "staff");
    if (mode === "initial-denied") {
      original.narrow();
    }
    const entered = createDeferred();
    const proceed = createDeferred();
    const releaseRuntime = vi.fn(async () => undefined);
    snapshotResources.acquire = () => ({ release: releaseRuntime });
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    resolveModelAsyncMock.mockImplementation(async () => {
      entered.resolve();
      await proceed.promise;
      return { model };
    });
    const provider = installProvider();
    if (mode === "late-rebound") {
      resolveEmbeddedAgentStreamMock.mockImplementation(
        (params: Parameters<typeof resolveEmbeddedAgentStream>[0]) => {
          const resolved = resolveEmbeddedAgentStream(params);
          const streamFn: StreamFn = (actual, context, options) => {
            const pending = resolved.streamFn(actual, context, options);
            // The real credential callback has entered its await with the old route captured.
            // A separately allowed host selection cannot replace that in-flight invocation.
            Object.assign(actual, mappedModel("other", "other"));
            return pending;
          };
          return { ...resolved, streamFn };
        },
      );
    }
    const owner = new AsyncWorkScope();
    const pending = owner.run(() =>
      runSideQuestion({
        provider: "btw-policy",
        model: "selected",
        opts: { operatorAuthority: original.authority },
      }),
    );
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      if (mode !== "initial-denied") {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Model resolution hold missed");
          }),
        ]);
        expect(getApiKeyForModelMock).not.toHaveBeenCalled();
        expect(releaseRuntime).not.toHaveBeenCalled();
        if (mode === "source-revoked") {
          original.cancellation.abort(new Error("BTW source revoked"));
        }
        if (mode === "policy-narrowed") {
          original.narrow();
        }
      }
      proceed.resolve();
      const result = await outcome;
      if (mode === "mapped" || mode === "cached" || mode === "staff") {
        expect(result).toEqual({ value: { text: "Mapped answer" } });
        expect(provider).toHaveBeenCalledOnce();
        expect(readModelRequestRoute(provider.mock.calls[0]?.[0] ?? {})?.logicalRef).toEqual({
          provider: "btw-policy",
          model: "selected",
        });
        expect(getApiKeyForModelMock).toHaveBeenCalledWith(
          expect.objectContaining({ model: expect.objectContaining({ id: model.id }) }),
        );
        expect(
          ensureSelectedAgentHarnessPluginMock.mock.calls.map(([params]) => params.modelId),
        ).toEqual(mode === "cached" ? ["selected"] : ["selected", "wire-model"]);
      } else {
        expect(result).toHaveProperty("error");
        expect(provider).not.toHaveBeenCalled();
        if (mode !== "late-rebound") {
          expect(getApiKeyForModelMock).not.toHaveBeenCalled();
          expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
        }
        if (mode === "initial-denied") {
          expect(resolveModelAsyncMock).not.toHaveBeenCalled();
          expect(ensureSelectedAgentHarnessPluginMock).not.toHaveBeenCalled();
        }
      }
    } finally {
      proceed.resolve();
      await outcome;
      await AsyncWorkScope.runWhenAllIdle(
        () => [owner],
        () => owner.drain(),
      );
    }
    expect(releaseRuntime).toHaveBeenCalledTimes(mode === "initial-denied" ? 0 : 1);
    expect(original.releases.length).toBeGreaterThan(0);
    for (const release of original.releases) {
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it.each(["mapped", "revoked", "narrowed"] as const)(
    "refreshes the logical model while preserving the physical auth target (%s)",
    async (mode) => {
      installHarness();
      const original = operatorSource();
      const model = mappedModel();
      const authStorage = { id: "btw-auth-storage" };
      const modelRegistry = { id: "btw-model-registry" };
      discoverAuthStorageMock.mockReturnValue(authStorage);
      discoverModelsMock.mockReturnValue(modelRegistry);
      ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
        version: 1,
        profiles: {
          "btw-policy:primary": { type: "api_key", provider: "btw-policy", key: "primary-key" },
          "btw-policy:backup": { type: "api_key", provider: "btw-policy", key: "backup-key" },
        },
        order: { "btw-policy": ["btw-policy:primary", "btw-policy:backup"] },
      });
      resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
      getApiKeyForModelMock.mockImplementation(async ({ profileId }: { profileId?: string }) => {
        if (profileId === "btw-policy:primary") {
          throw new Error("Primary unavailable");
        }
        if (profileId !== "btw-policy:backup") {
          throw new Error("Expected prepared backup");
        }
        return {
          apiKey: "backup-key",
          mode: "api-key",
          source: "profile:btw-policy:backup",
          profileId,
        };
      });
      const entered = createDeferred();
      const proceed = createDeferred();
      resolveModelAsyncMock.mockResolvedValueOnce({ model }).mockImplementation(async () => {
        entered.resolve();
        await proceed.promise;
        return { model, authStorage, modelRegistry };
      });
      const releaseRuntime = vi.fn(async () => undefined);
      snapshotResources.acquire = () => ({ release: releaseRuntime });
      const provider = installProvider();
      const owner = new AsyncWorkScope();
      const pending = owner.run(() =>
        runSideQuestion({
          provider: "btw-policy",
          model: "selected",
          opts: { operatorAuthority: original.authority },
        }),
      );
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Credential refresh hold missed");
          }),
        ]);
        expect(resolveModelAsyncMock).toHaveBeenLastCalledWith(
          "btw-policy",
          "selected",
          DEFAULT_AGENT_DIR,
          expect.any(Object),
          expect.objectContaining({
            modelIdSource: "selected",
            authProfileId: "btw-policy:backup",
            authProfileMode: "api_key",
            authStorage,
            modelRegistry,
          }),
        );
        expect(
          getApiKeyForModelMock.mock.calls.map(([params]) => [
            params.model.provider,
            params.model.id,
            params.profileId,
          ]),
        ).toEqual([
          ["btw-policy", "wire-model", "btw-policy:primary"],
          ["btw-policy", "wire-model", "btw-policy:backup"],
        ]);
        expect(prepareProviderRuntimeAuthMock).not.toHaveBeenCalled();
        expect(provider).not.toHaveBeenCalled();
        expect(releaseRuntime).not.toHaveBeenCalled();
        if (mode === "revoked") {
          original.cancellation.abort(new Error("BTW refresh source revoked"));
        }
        if (mode === "narrowed") {
          original.narrow();
        }
        proceed.resolve();
        const result = await outcome;
        if (mode === "mapped") {
          expect(result).toEqual({ value: { text: "Mapped answer" } });
          expect(prepareProviderRuntimeAuthMock).toHaveBeenCalledWith(
            expect.objectContaining({
              provider: "btw-policy",
              context: expect.objectContaining({
                modelId: "wire-model",
                profileId: "btw-policy:backup",
              }),
            }),
          );
          expect(provider).toHaveBeenCalledOnce();
        } else {
          expect(result).toHaveProperty("error");
          expect(prepareProviderRuntimeAuthMock).not.toHaveBeenCalled();
          expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
          expect(provider).not.toHaveBeenCalled();
        }
      } finally {
        proceed.resolve();
        await outcome;
        await AsyncWorkScope.runWhenAllIdle(
          () => [owner],
          () => owner.drain(),
        );
      }
      expect(releaseRuntime).toHaveBeenCalledOnce();
      expect(original.releases.length).toBeGreaterThan(0);
      for (const release of original.releases) {
        expect(release).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["mapped", "same-tuple"] as const)(
    "hands the validated model to the selected harness (%s)",
    async (mode) => {
      const model = mode === "mapped" ? mappedModel() : mappedModel("selected");
      const original = operatorSource();
      const sideQuestion = vi
        .fn<NonNullable<AgentHarness["runSideQuestion"]>>()
        .mockResolvedValue({ text: "Harness answer" });
      installHarness(sideQuestion);
      resolveModelAsyncMock.mockResolvedValue({ model });
      resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
      const releaseRuntime = vi.fn(async () => undefined);
      snapshotResources.acquire = () => ({ release: releaseRuntime });
      const owner = new AsyncWorkScope();
      try {
        await expect(
          owner.run(() =>
            runSideQuestion({
              provider: "btw-policy",
              model: "selected",
              opts: { operatorAuthority: original.authority },
            }),
          ),
        ).resolves.toEqual({ text: "Harness answer" });
        expect(sideQuestion).toHaveBeenCalledOnce();
        expect(sideQuestion).toHaveBeenCalledWith(
          expect.objectContaining({ provider: "btw-policy", model: model.id, runtimeModel: model }),
        );
        expect(closeAgentHarnessHostCapabilitiesMock).toHaveBeenCalledOnce();
        expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
      } finally {
        await AsyncWorkScope.runWhenAllIdle(
          () => [owner],
          () => owner.drain(),
        );
      }
      expect(releaseRuntime).toHaveBeenCalledOnce();
      expect(original.releases.length).toBeGreaterThan(0);
      for (const release of original.releases) {
        expect(release).toHaveBeenCalledOnce();
      }
    },
  );
});
