import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindModelRequestRoute, bindStreamLlmRuntime } from "../../../llm/model-runtime-binding.js";
import { attachModelProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-operator-authority.js";
import {
  captureOperatorModelRequest,
  prepareOperatorModelPolicy,
  runWithOperatorModelRequest,
} from "../../operator-model-policy.js";
import * as providerStreams from "../../provider-stream.js";
import type { StreamFn } from "../../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createEmptyAgentDiscoveryStores } from "../model.js";
import { prepareEmbeddedAttemptTransport } from "./attempt-stream-settle.js";

registerAgentSessionLoopTestLifecycle();

describe("prepared attempt credential callback model authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "mapped",
    "retained-revoked",
    "ambient-revoked",
    "policy-narrowed",
    "deadline",
    "late-allowed-route",
  ] as const)("uses the production callback across held auth: %s", async (change) => {
    const runtimeHandle = { provider: "fixture", modelId: "selected" };
    const model = attachModelProviderRuntimePluginHandle(
      bindModelRequestRoute(
        makeProviderModelFixture({
          provider: "fixture",
          id: "vendor/selected",
          api: "openai-completions",
          baseUrl: "https://provider.example/v1",
        }),
        { provider: "fixture", model: "selected" },
      ),
      runtimeHandle,
    );
    const source = {};
    const retainedCancellation = new AbortController();
    const ambientCancellation = new AbortController();
    const release = vi.fn();
    const initialPolicy = prepareOperatorModelPolicy({
      cfg: {},
      policy: { allow: ["fixture/selected", "fixture/other"] },
      manifestPlugins: [],
    });
    expect(initialPolicy?.allows({ provider: model.provider, model: model.id })).toBe(false);
    let policy = initialPolicy;
    const retained = createAdmittedRunOperatorAuthority({
      profileId: "viewer",
      source,
      scopes: ["operator.write"],
      signal: retainedCancellation.signal,
      assertCurrent() {},
      retain: () => release,
      get modelPolicy() {
        return policy;
      },
    });
    const deadline = Date.now() + 60_000;
    const ambient = createAdmittedRunOperatorAuthority({
      profileId: "viewer",
      source,
      scopes: ["operator.sessions.write"],
      modelPolicy: initialPolicy,
      signal: ambientCancellation.signal,
      executionPolicy: "foreground-only",
      foregroundRunId: "mapped-stream",
      foregroundDeadlineAt: deadline,
      assertCurrent() {},
    });
    const admission = prepareAgentRunAdmission({
      cfg: {},
      facts: {
        runId: "mapped-stream",
        agentId: "main",
        ingress: { kind: "system", boundary: "test", state: "present" },
      },
      operationalRunInstance: createOperationalRunInstanceRef("mapped-stream"),
      operatorAuthority: retained,
    });
    const entered = createDeferredCore();
    const key = createDeferredCore<string>();
    let pending: Promise<Awaited<ReturnType<StreamFn>>> | undefined;
    let checked: Promise<unknown> | undefined;
    try {
      const admittedRunContext = await admission.admit("embedded", "openclaw");
      const { session, settingsManager } = await createTestSession({ model });
      const response = createAssistantResultStream(createAssistant(model, []));
      const provider = vi.fn<StreamFn>((actual) => {
        const binding = captureOperatorModelRequest(actual);
        if (!binding) {
          throw new Error("Original model request capture missing");
        }
        binding.bindWireModel(actual.id, actual)(actual, actual.id);
        return response;
      });
      Object.assign(provider, { modelRequestBinding: "wire-model-v1" as const });
      bindStreamLlmRuntime(provider, defaultLlmRuntime);
      session.agent.streamFn = provider;
      vi.spyOn(providerStreams, "registerProviderStreamForModel").mockReturnValue(provider);
      const stores = createEmptyAgentDiscoveryStores();
      const getApiKey = vi
        .spyOn(stores.authStorage, "getApiKey")
        .mockResolvedValueOnce("fixture-key")
        .mockImplementation(async () => {
          entered.resolve();
          return key.promise;
        });
      const prepared = await prepareEmbeddedAttemptTransport({
        attempt: {
          admittedRunContext,
          model,
          provider: "fixture",
          modelId: "selected",
          config: { agents: { defaults: { params: { transport: "sse" } } } },
          runId: "mapped-stream",
          sessionId: "mapped-stream",
          sessionFile: "mapped-stream",
          workspaceDir: "/workspace",
          prompt: "Mapped stream",
          timeoutMs: 5_000,
          thinkLevel: "off",
          authProfileStore: { version: 1, profiles: {} },
          ...stores,
        },
        session,
        settingsManager,
        providerThinkingLevel: undefined,
        sessionAgentId: "main",
        workspaceDir: "/workspace",
        workspaceOnly: false,
        agentDir: "/agent",
        abortSignal: new AbortController().signal,
        getProviderRuntimeHandle: () => runtimeHandle,
        sandboxSessionKey: "agent:main:mapped-stream",
        codeModeControlsEnabled: false,
        providerPromptState: { state: {}, effectiveContextTokenBudget: 16_000 },
      });
      expect(prepared.effectiveAgentTransport).toBe("sse");
      expect(prepared.effectiveExtraParams.transport).toBe("sse");
      expect(session.agent.transport).toBe("sse");
      expect(getApiKey).toHaveBeenCalledOnce();
      const stream = session.agent.streamFn;
      if (!stream) {
        throw new Error("Prepared stream missing");
      }
      const actual = { ...model };
      pending = Promise.resolve(
        runWithOperatorModelRequest(ambient, () =>
          stream(actual, { messages: [] }, { transport: "sse" }),
        ),
      );
      checked =
        change === "mapped"
          ? expect(pending).resolves.toBe(response)
          : change === "retained-revoked"
            ? expect(pending).rejects.toThrow("admitted run authority is no longer active")
            : expect(pending).rejects.toMatchObject({ code: "OPERATOR_MODEL_POLICY_DENIED" });
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Credential hold missed");
        }),
      ]);
      expect(provider).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      if (change === "retained-revoked") {
        retainedCancellation.abort(new Error("retained source revoked"));
      } else if (change === "ambient-revoked") {
        ambientCancellation.abort(new Error("ambient source revoked"));
      } else if (change === "policy-narrowed") {
        policy = prepareOperatorModelPolicy({
          cfg: {},
          policy: { allow: [] },
          manifestPlugins: [],
        });
        expect(() => retained.assertCurrent()).not.toThrow();
      } else if (change === "deadline") {
        vi.spyOn(Date, "now").mockReturnValue(deadline);
      } else if (change === "late-allowed-route") {
        // A separately valid host selection cannot replace this already captured request.
        const other = bindModelRequestRoute(
          { ...model, id: "other" },
          { provider: "fixture", model: "other" },
        );
        Object.assign(actual, other);
      }
      key.resolve("fixture-key");
      await checked;
      expect(getApiKey).toHaveBeenCalledTimes(2);
      expect(provider).toHaveBeenCalledTimes(change === "mapped" ? 1 : 0);
      expect(release).not.toHaveBeenCalled();
    } finally {
      key.resolve("fixture-key");
      await Promise.allSettled([pending, checked]);
      admission.close();
    }
    expect(release).toHaveBeenCalledOnce();
  });
});
