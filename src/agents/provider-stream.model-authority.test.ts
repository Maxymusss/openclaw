import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import {
  notifyProviderHttpMetadata,
  prepareModelForSimpleCompletion,
} from "@openclaw/ai/transports";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { bindModelCompletionOwner, bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import type { AssistantMessage, Model } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { isRetryableAssistantError } from "../llm/utils/retry.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import type { ProviderPlugin } from "../plugins/provider-plugin.types.js";
import type { ProviderWrapStreamFnContext } from "../plugins/provider-transport.types.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-operator-authority.js";
import { resolveEmbeddedAgentStream } from "./embedded-agent-runner/stream-resolution.js";
import { requireIsolatedAssistantText } from "./isolated-completion-output.js";
import {
  captureOperatorModelRequest,
  OperatorModelPolicyError,
  runWithOperatorModelRequest,
} from "./operator-model-policy.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { Agent, type StreamFn } from "./runtime/index.js";
import { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

function originalAuthority(allow: string[]) {
  let current = true;
  return {
    revoke: () => {
      current = false;
    },
    authority: createAdmittedRunOperatorAuthority({
      profileId: "stream-owner",
      scopes: ["operator.sessions.write"],
      permissions: { models: { allow } },
      assertCurrent: () => {
        if (!current) {
          throw new Error("HTTP 503: original model source revoked");
        }
      },
    }),
  };
}

type RequestMode = "stream" | "completion" | "agent";

function preparedProvider(
  mode: RequestMode,
  completionOwner?: Parameters<typeof bindModelCompletionOwner>[1],
) {
  const registry = createApiRegistry();
  const runtime = createLlmRuntime(registry);
  const requests = new Map<
    string,
    {
      target: Pick<Model, "provider" | "id">;
      entered: Deferred;
      release: Deferred;
    }
  >();
  const raw = vi.fn<StreamFn>((model) => {
    const binding = captureOperatorModelRequest(model);
    binding?.bindWireModel(model.id, model)(model, model.id);
    const result = createAssistantMessageEventStream();
    const message = buildAssistantMessage({
      model,
      content: [{ type: "text", text: "accepted" }],
      stopReason: "stop",
      usage: buildUsageWithNoCost({}),
    });
    result.push({ type: "done", reason: "stop", message });
    return result;
  });
  Object.assign(raw, { modelRequestBinding: "wire-model-v1" as const });
  const createStreamFn = vi.fn(() => raw);
  const wrapperCalls = vi.fn<(sessionId: string | undefined) => void>();
  const wrap = vi.fn((context: ProviderWrapStreamFnContext): StreamFn => {
    const inner = expectDefined(context.streamFn, "prepared provider delegate");
    const wrapper: StreamFn = async (model, requestContext, options) => {
      wrapperCalls(options?.sessionId);
      const request = expectDefined(requests.get(options?.sessionId ?? ""), "owned request");
      request.entered.resolve();
      await request.release.promise;
      return inner({ ...model, ...request.target }, requestContext, options);
    };
    // This fixture has no egress of its own and always calls the guarded delegate.
    return Object.assign(wrapper, { modelRequestBinding: "wire-model-v1" as const });
  });
  const plugin: ProviderPlugin = {
    id: "fixture",
    label: "Fixture",
    auth: [],
    createStreamFn,
    ...(mode === "completion" ? { wrapSimpleCompletionStreamFn: wrap } : { wrapStreamFn: wrap }),
  };
  const model = attachModelProviderRuntimePluginHandle(
    makeProviderModelFixture({
      api: "fixture-model-authority",
      provider: "fixture",
      id: "requested",
      baseUrl: "https://provider.example/v1",
    }),
    { provider: "fixture", modelId: "requested", plugin },
  );
  // Prepare once, before any caller enters. Cached factories must remain authority-neutral.
  const preparedRuntime =
    mode === "completion"
      ? bindModelLlmRuntime(
          model,
          runtime,
          prepareModelForSimpleCompletion({ apiRegistry: registry, model }),
        )
      : model;
  const prepared = completionOwner
    ? bindModelCompletionOwner(preparedRuntime, completionOwner)
    : preparedRuntime;
  const providerStream =
    mode === "completion"
      ? undefined
      : expectDefined(
          registerProviderStreamForModel({
            model,
            apiRegistry: registry,
            wrapProviderStream: true,
          }),
          "registered provider stream",
        );
  const start = (
    sessionId: string,
    target: Pick<Model, "provider" | "id">,
    operatorAuthority?: AdmittedRunOperatorAuthority,
  ) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    requests.set(sessionId, { target, entered, release });
    let result: Promise<AssistantMessage>;
    if (mode === "completion") {
      result = completeWithPreparedSimpleCompletionModel({
        model: prepared,
        auth: { apiKey: "fixture-key", source: "fixture", mode: "api-key" },
        context: { messages: [] },
        options: { sessionId },
        operatorAuthority,
      });
    } else {
      const { streamFn } = resolveEmbeddedAgentStream({
        llmRuntime: runtime,
        currentStreamFn: runtime.streamSimple,
        ...(mode === "agent" ? { providerStreamFn: providerStream } : {}),
        model: prepared,
        sessionId,
        operatorAuthority,
      });
      if (mode === "agent") {
        const agent = new Agent({ initialState: { model: prepared }, streamFn, sessionId });
        result = agent.prompt("hello").then(() =>
          expectDefined(
            agent.state.messages.findLast((message) => message.role === "assistant"),
            "actual Agent terminal message",
          ),
        );
      } else {
        result = Promise.resolve(streamFn(prepared, { messages: [] }, { sessionId })).then(
          (stream) => stream.result(),
        );
      }
    }
    return {
      entered: () =>
        Promise.race([
          entered.promise,
          result.then(() => {
            throw new Error("Provider request settled before entering its wrapper.");
          }),
        ]),
      release: () => release.resolve(),
      result,
    };
  };
  return { start, raw, createStreamFn, wrap, wrapperCalls };
}

it("retains SDK-owned completion authority through cancelled provider callback and cleanup tails", async () => {
  const host = new LegacyPluginSdkResourceHost();
  const f = preparedProvider("completion", {
    run: (run) => host.track(run),
    assertCurrent: () => host.assertOpen(),
  });
  const callbackStarted = createDeferredCore();
  const callbackDone = createDeferredCore();
  const cleanupDone = createDeferredCore();
  const controller = new AbortController();
  const release = vi.fn();
  const retain = vi.fn(() => release);
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "completion-owner",
    scopes: ["operator.sessions.write"],
    permissions: { models: { allow: ["fixture/requested"] } },
    assertCurrent: () => {},
    retain,
  });
  const cancelStream = vi.fn(() => cleanupDone.promise);
  const onResponse = vi.fn(() => {
    callbackStarted.resolve();
    return callbackDone.promise;
  });
  f.raw.mockImplementationOnce((model) => {
    const binding = captureOperatorModelRequest(model);
    binding?.bindWireModel(model.id, model)(model, model.id);
    const stream = createAssistantMessageEventStream();
    void notifyProviderHttpMetadata({
      options: { signal: controller.signal, onResponse },
      response: { status: 200, headers: {} },
      model,
      cancelStream,
    }).catch((error: unknown) => {
      stream.push({
        type: "error",
        reason: "aborted",
        error: {
          ...buildAssistantMessage({
            model,
            content: [],
            stopReason: "aborted",
            usage: buildUsageWithNoCost({}),
          }),
          errorMessage: String(error),
        },
      });
    });
    return stream;
  });
  const request = f.start("owned-completion", { provider: "fixture", id: "requested" }, authority);
  try {
    await request.entered();
    request.release();
    await Promise.race([
      callbackStarted.promise,
      request.result.then(() => {
        throw new Error("Completion settled before its provider callback.");
      }),
    ]);
    controller.abort();
    await expect(request.result).resolves.toMatchObject({ stopReason: "aborted" });
    expect(onResponse).toHaveBeenCalledOnce();
    expect(cancelStream).toHaveBeenCalledOnce();
    expect(retain).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    callbackDone.resolve();
    await callbackDone.promise;
    expect(release).not.toHaveBeenCalled();
    cleanupDone.resolve();
    await host.drainWork();
    expect(release).toHaveBeenCalledOnce();
  } finally {
    controller.abort();
    request.release();
    callbackDone.resolve();
    cleanupDone.resolve();
    await Promise.allSettled([request.result, host.close()]);
  }
});

async function expectDenied(mode: RequestMode, result: Promise<AssistantMessage>) {
  if (mode === "completion") {
    await expect(result).rejects.toMatchObject({ code: "OPERATOR_MODEL_POLICY_DENIED" });
    return;
  }
  const message = await result;
  expect(message).toMatchObject({
    stopReason: "error",
    errorCode: "OPERATOR_MODEL_POLICY_DENIED",
  });
  expect(isRetryableAssistantError(message)).toBe(false);
  expect(() => requireIsolatedAssistantText(message)).toThrow(OperatorModelPolicyError);
}

describe.each(["stream", "completion", "agent"] as const)(
  "cached %s provider authority",
  (mode) => {
    it.each(["model", "provider"] as const)(
      "isolates concurrent callers after an awaited %s rewrite without recreating the factory",
      async (rewrite) => {
        const f = preparedProvider(mode);
        const target = { provider: rewrite === "provider" ? "other" : "fixture", id: "selected" };
        const allowed = originalAuthority(["fixture/requested", `${target.provider}/selected`]);
        const denied = originalAuthority(["fixture/requested"]);
        const yes = f.start("allowed", target, allowed.authority);
        const no = f.start("denied", target, denied.authority);
        const denial = expectDenied(mode, no.result);
        const accepted = expect(yes.result).resolves.toMatchObject({ stopReason: "stop" });
        try {
          await Promise.all([yes.entered(), no.entered()]);
          expect(f.raw).not.toHaveBeenCalled();
          no.release();
          await denial;
          expect(f.raw).not.toHaveBeenCalled();
          yes.release();
          await accepted;
          expect(f.raw).toHaveBeenCalledOnce();
          expect(f.raw.mock.calls[0]?.[0]).toMatchObject(target);
          expect(f.wrapperCalls).toHaveBeenCalledTimes(2);
        } finally {
          yes.release();
          no.release();
          await Promise.allSettled([yes.result, no.result, denial, accepted]);
        }
        const unrestricted = f.start("later-unrestricted", { provider: "other", id: "later" });
        unrestricted.release();
        await expect(unrestricted.result).resolves.toMatchObject({ stopReason: "stop" });
        expect(f.raw).toHaveBeenCalledTimes(2);
        expect(f.createStreamFn).toHaveBeenCalledOnce();
        expect(f.wrap).toHaveBeenCalledOnce();
      },
    );

    it("checks original source revocation after plugin preparation and preserves terminal policy identity", async () => {
      const f = preparedProvider(mode);
      const original = originalAuthority(["fixture/requested", "fixture/selected"]);
      const request = f.start(
        "revoked",
        { provider: "fixture", id: "selected" },
        original.authority,
      );
      const denied = expectDenied(mode, request.result);
      try {
        await request.entered();
        original.revoke();
      } finally {
        request.release();
      }
      await denied;
      expect(f.raw).not.toHaveBeenCalled();
      expect(f.wrapperCalls).toHaveBeenCalledOnce();
    });

    it("inherits an outer operator when nested authority is omitted and leaves independent calls unrestricted", async () => {
      const f = preparedProvider(mode);
      const original = originalAuthority(["fixture/requested"]);
      await runWithOperatorModelRequest(original.authority, async () => {
        const nested = f.start("nested-omission", { provider: "fixture", id: "other-model" });
        const nestedDenied = expectDenied(mode, nested.result);
        nested.release();
        await nestedDenied;
        const outer = f.start(
          "outer-operator",
          { provider: "fixture", id: "other-model" },
          original.authority,
        );
        const denied = expectDenied(mode, outer.result);
        outer.release();
        await denied;
      });
      expect(f.raw).not.toHaveBeenCalled();
      expect(f.wrapperCalls).toHaveBeenCalledTimes(2);
      const independent = f.start("independent", { provider: "fixture", id: "other-model" });
      independent.release();
      await expect(independent.result).resolves.toMatchObject({ stopReason: "stop" });
      expect(f.raw).toHaveBeenCalledOnce();
      expect(f.createStreamFn).toHaveBeenCalledOnce();
      expect(f.wrap).toHaveBeenCalledOnce();
    });
  },
);
