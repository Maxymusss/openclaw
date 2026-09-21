import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.js";
import {
  assertOperatorModelResponse,
  guardOperatorModelProviderStream,
  OperatorModelPolicyError,
  runWithOperatorModelAuthority,
  runWithOperatorModelRequest,
} from "./operator-model-policy.js";
import type { StreamFn } from "./runtime/index.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

describe("operator model request lifetime", () => {
  it("retains its original source until accepted asynchronous work drains", async () => {
    const owner = new AsyncWorkScope();
    const finish = createDeferredCore();
    const release = vi.fn();
    const retain = vi.fn(() => release);
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "original-person",
      scopes: ["operator.sessions.write"],
      permissions: { models: { allow: [] } },
      assertCurrent: () => {},
      retain,
    });
    const result = owner.run(() =>
      runWithOperatorModelRequest(authority, () =>
        runWithOperatorModelAuthority(undefined, async () => {
          void trackAsyncWork(() => finish.promise);
          return "accepted";
        }),
      ),
    );
    try {
      expect(await result).toBe("accepted");
      expect(retain).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      expect(owner.hasPendingWork).toBe(true);
    } finally {
      finish.resolve();
      await owner.drain();
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps the enclosing authority when a nested invocation omits it", async () => {
    const model = makeProviderModelFixture({
      api: "fixture",
      provider: "fixture",
      id: "selected",
      baseUrl: "https://provider.example/v1",
    });
    const raw = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    const cached = guardOperatorModelProviderStream(raw);
    const original = createAdmittedRunOperatorAuthority({
      profileId: "original-person",
      scopes: ["operator.sessions.write"],
      permissions: { models: { allow: [] } },
      assertCurrent: () => {},
    });
    await runWithOperatorModelRequest(original, async () => {
      await runWithOperatorModelRequest(undefined, async () => {
        await Promise.resolve();
        expect(() => cached(model, { messages: [] })).toThrow(OperatorModelPolicyError);
      });
      expect(() => cached(model, { messages: [] })).toThrow(OperatorModelPolicyError);
    });
    expect(raw).not.toHaveBeenCalled();
    cached(model, { messages: [] });
    expect(raw).toHaveBeenCalledOnce();
  });

  it("does not interpret a stale error code on successful output as a denial", () => {
    expect(() =>
      assertOperatorModelResponse({
        stopReason: "stop",
        errorCode: "OPERATOR_MODEL_POLICY_DENIED",
      }),
    ).not.toThrow();
  });
});
