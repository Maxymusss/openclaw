import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-operator-authority.js";
import { assertOperatorModelAllowed } from "../operator-model-policy.js";
import type { StreamFn } from "../runtime/index.js";
import { resolveEmbeddedAgentStream } from "./stream-resolution.js";

describe("embedded stream model authority", () => {
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
      const provider = vi.fn<StreamFn>(() => response);
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
