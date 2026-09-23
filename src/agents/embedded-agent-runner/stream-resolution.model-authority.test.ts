import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-operator-authority.js";
import {
  assertOperatorModelAllowed,
  captureOperatorModelRequest,
  runWithOperatorModelRequest,
} from "../operator-model-policy.js";
import type { StreamFn } from "../runtime/index.js";
import { resolveEmbeddedAgentStream } from "./stream-resolution.js";

describe("embedded stream model authority", () => {
  it.each(["retained-staff", "retained-guest"] as const)(
    "refuses an incompatible %s stream before auth or inference and preserves standalone staff",
    async (kind) => {
      const model: Model = {
        provider: "fixture",
        id: "forbidden",
        name: "Forbidden",
        api: "openai-completions",
        baseUrl: "https://provider.example/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      };
      const staff = createAdmittedRunOperatorAuthority({
        profileId: "staff",
        scopes: ["operator.admin"],
        assertCurrent() {},
      });
      const guest = createAdmittedRunOperatorAuthority({
        profileId: "guest",
        scopes: ["operator.sessions.write"],
        permissions: { models: { allow: ["fixture/allowed"] } },
        assertCurrent() {},
      });
      const response = createAssistantMessageEventStream();
      const provider = vi.fn<StreamFn>(() => response);
      Object.assign(provider, { modelRequestBinding: "wire-model-v1" as const });
      const getApiKey = vi.fn(async () => "fixture-key");
      const resolve = (authority: typeof staff) =>
        resolveEmbeddedAgentStream({
          llmRuntime: defaultLlmRuntime,
          currentStreamFn: undefined,
          providerStreamFn: provider,
          model,
          operatorAuthority: authority,
          sessionId: "retained-session",
          authStorage: { getApiKey },
        }).streamFn;
      const retained = resolve(kind === "retained-staff" ? staff : guest);
      expect(() =>
        runWithOperatorModelRequest(kind === "retained-staff" ? guest : staff, () =>
          retained(model, { messages: [] }, { transport: "sse" }),
        ),
      ).toThrow(/retained model source/);
      expect(getApiKey).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(await resolve(staff)(model, { messages: [] }, { transport: "sse" })).toBe(response);
      expect(getApiKey).toHaveBeenCalledOnce();
      expect(provider).toHaveBeenCalledOnce();
    },
  );

  it.each(["allowed", "retained-revoked", "ambient-revoked", "deadline"] as const)(
    "keeps both compatible captures through auth acquisition: %s",
    async (change) => {
      const source = {};
      let retainedCurrent = true;
      let ambientCurrent = true;
      const deadline = Date.now() + 60_000;
      const retained = createAdmittedRunOperatorAuthority({
        profileId: "same-person",
        source,
        scopes: ["operator.write"],
        assertCurrent: () => {
          if (!retainedCurrent) {
            throw new Error("retained source revoked");
          }
        },
      });
      const ambient = createAdmittedRunOperatorAuthority({
        profileId: "same-person",
        source,
        scopes: ["operator.sessions.write"],
        permissions: { models: { allow: ["fixture/allowed"] } },
        executionPolicy: "foreground-only",
        foregroundRunId: "original-turn",
        foregroundDeadlineAt: deadline,
        assertCurrent: () => {
          if (!ambientCurrent) {
            throw new Error("ambient source revoked");
          }
        },
      });
      const model: Model = {
        provider: "fixture",
        id: "allowed",
        name: "Allowed",
        api: "openai-completions",
        baseUrl: "https://provider.example/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      };
      const entered = createDeferredCore();
      const key = createDeferredCore<string>();
      const response = createAssistantMessageEventStream();
      const provider = vi.fn<StreamFn>((actual) => {
        const binding = captureOperatorModelRequest(actual);
        expect(binding).toBeDefined();
        binding?.bindWireModel(actual.id, actual)(actual, actual.id);
        return response;
      });
      Object.assign(provider, { modelRequestBinding: "wire-model-v1" as const });
      const { streamFn } = resolveEmbeddedAgentStream({
        llmRuntime: defaultLlmRuntime,
        currentStreamFn: undefined,
        providerStreamFn: provider,
        model,
        operatorAuthority: retained,
        sessionId: "same-source-session",
        authStorage: {
          getApiKey: async () => {
            entered.resolve();
            return key.promise;
          },
        },
        assertModelCurrent: (actual) =>
          assertOperatorModelAllowed(retained, actual.provider, actual.id),
      });
      const pending = Promise.resolve(
        runWithOperatorModelRequest(ambient, () =>
          streamFn(model, { messages: [] }, { transport: "sse" }),
        ),
      );
      const checked =
        change === "allowed"
          ? expect(pending).resolves.toBe(response)
          : expect(pending).rejects.toMatchObject({ code: "OPERATOR_MODEL_POLICY_DENIED" });
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Auth hold missed");
          }),
        ]);
        retainedCurrent = change !== "retained-revoked";
        ambientCurrent = change !== "ambient-revoked";
        if (change === "deadline") {
          vi.spyOn(Date, "now").mockReturnValue(deadline);
        }
        key.resolve("fixture-key");
        await checked;
        expect(provider).toHaveBeenCalledTimes(change === "allowed" ? 1 : 0);
      } finally {
        key.resolve("fixture-key");
        await Promise.allSettled([pending, checked]);
        vi.restoreAllMocks();
      }
    },
  );

  it.each(["allowed", "source-revoked", "model-replaced"] as const)(
    "rechecks the actual request after auth acquisition: %s",
    async (change) => {
      let current = true;
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "viewer",
        scopes: ["operator.sessions.write"],
        permissions: { models: { allow: ["fixture/allowed"] } },
        assertCurrent: () => {
          if (!current) {
            throw new Error("original model source revoked");
          }
        },
      });
      const model: Model = {
        provider: "fixture",
        id: "allowed",
        name: "Allowed",
        api: "openai-completions",
        baseUrl: "https://provider.example/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      };
      const key = createDeferredCore<string | undefined>();
      const acquired = createDeferredCore();
      const response = createAssistantMessageEventStream();
      const provider = vi.fn<StreamFn>((actual) => {
        const binding = captureOperatorModelRequest(actual);
        binding?.bindWireModel(actual.id, actual)(actual, actual.id);
        return response;
      });
      Object.assign(provider, { modelRequestBinding: "wire-model-v1" as const });
      const { streamFn } = resolveEmbeddedAgentStream({
        llmRuntime: defaultLlmRuntime,
        currentStreamFn: undefined,
        providerStreamFn: provider,
        model,
        operatorAuthority: authority,
        sessionId: "original-session",
        authStorage: {
          getApiKey: async () => {
            acquired.resolve();
            return key.promise;
          },
        },
        assertModelCurrent: (actual) =>
          assertOperatorModelAllowed(authority, actual.provider, actual.id),
      });
      const request = Promise.resolve(streamFn(model, { messages: [] }, {}));
      const settled =
        change === "allowed"
          ? expect(request).resolves.toBe(response)
          : expect(request).rejects.toMatchObject({ code: "OPERATOR_MODEL_POLICY_DENIED" });
      try {
        await acquired.promise;
        if (change === "source-revoked") {
          current = false;
        } else if (change === "model-replaced") {
          model.id = "forbidden";
        }
      } finally {
        key.resolve("fixture-key");
      }
      await settled;
      if (change === "allowed") {
        expect(provider).toHaveBeenCalledExactlyOnceWith(
          model,
          { messages: [] },
          { apiKey: "fixture-key" },
        );
      } else {
        expect(provider).not.toHaveBeenCalled();
      }
    },
  );
});
