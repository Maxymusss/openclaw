import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import {
  createOpenClawTransportStreamFnForModel,
  prepareModelForSimpleCompletion,
} from "@openclaw/ai/transports";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.js";
import {
  captureOperatorModelRequest,
  runWithOperatorModelRequest,
  wrapOperatorModelStream,
} from "./operator-model-policy.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import type { StreamFn } from "./runtime/index.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const socket = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("unexpected socket acquisition");
  }),
);
vi.mock("openai/resources/responses/ws.js", () => ({ ResponsesWS: socket }));

function finiteAuthority() {
  return createAdmittedRunOperatorAuthority({
    profileId: "transport-operator",
    scopes: ["operator.sessions.write"],
    permissions: { models: { allow: ["fixture/allowed", "openai/allowed"] } },
    assertCurrent: () => {},
  });
}

function terminalDelegate(qualified: boolean) {
  const delegate = vi.fn<StreamFn>((model) => {
    if (qualified) {
      const binding = captureOperatorModelRequest(model);
      binding?.bindWireModel(model.id, model)(model, model.id);
    }
    const stream = createAssistantMessageEventStream();
    const message = buildAssistantMessage({
      model,
      content: [],
      stopReason: "stop",
      usage: buildUsageWithNoCost({}),
    });
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  });
  if (qualified) {
    Object.assign(delegate, { modelRequestBinding: "wire-model-v1" as const });
  }
  return delegate;
}

const model = makeProviderModelFixture({
  provider: "fixture",
  id: "allowed",
  api: "fixture-binding",
  baseUrl: "https://provider.example/v1",
});

describe("finite transport delegate admission", () => {
  beforeEach(() => {
    socket.mockClear();
  });

  it.each(["stream", "streamSimple"] as const)(
    "%s rechecks the actual replacement through a retained dispatcher",
    async (method) => {
      const registry = createApiRegistry();
      const runtime = createLlmRuntime(registry);
      const qualified = terminalDelegate(true);
      const unsupported = terminalDelegate(false);
      const dispatcher = runtime[method];
      // These delegates are synchronous; the custom bridge preserves the same contract.
      const register = (delegate: StreamFn) => {
        registry.clearApiProviders();
        const prepared = attachModelProviderRuntimePluginHandle(model, {
          provider: model.provider,
          modelId: model.id,
          plugin: { id: "fixture", label: "Fixture", auth: [], createStreamFn: () => delegate },
        });
        registerProviderStreamForModel({ model: prepared, apiRegistry: registry });
      };
      register(qualified);
      const accepted = runWithOperatorModelRequest(finiteAuthority(), () =>
        dispatcher(model, { messages: [] }),
      );
      expect((await accepted.result()).stopReason).toBe("stop");
      expect(qualified).toHaveBeenCalledOnce();
      register(unsupported);
      expect(() =>
        runWithOperatorModelRequest(finiteAuthority(), () => dispatcher(model, { messages: [] })),
      ).toThrow(/cannot bind/);
      expect(unsupported).not.toHaveBeenCalled();
      expect((await dispatcher(model, { messages: [] }).result()).stopReason).toBe("stop");
      expect(unsupported).toHaveBeenCalledOnce();
    },
  );

  it.each(["embedded-wrapper", "simple-wrapper"] as const)(
    "does not promote an unqualified %s through core adapters",
    async (kind) => {
      const registry = createApiRegistry();
      const runtime = createLlmRuntime(registry);
      const raw = terminalDelegate(true);
      const wrapper = vi.fn<StreamFn>((...args) => raw(...args));
      const prepared = attachModelProviderRuntimePluginHandle(model, {
        provider: model.provider,
        modelId: model.id,
        plugin: {
          id: "fixture",
          label: "Fixture",
          auth: [],
          createStreamFn: () => raw,
          ...(kind === "embedded-wrapper"
            ? { wrapStreamFn: () => wrapper }
            : { wrapSimpleCompletionStreamFn: () => wrapper }),
        },
      });
      const dispatchModel =
        kind === "simple-wrapper"
          ? prepareModelForSimpleCompletion({ apiRegistry: registry, model: prepared })
          : prepared;
      if (kind === "embedded-wrapper") {
        registerProviderStreamForModel({
          model: prepared,
          apiRegistry: registry,
          wrapProviderStream: true,
        });
      }
      expect(() =>
        runWithOperatorModelRequest(finiteAuthority(), () =>
          runtime.streamSimple(dispatchModel, { messages: [] }),
        ),
      ).toThrow(/cannot bind/);
      expect(wrapper).not.toHaveBeenCalled();
      expect(raw).not.toHaveBeenCalled();
      expect((await runtime.completeSimple(dispatchModel, { messages: [] })).stopReason).toBe(
        "stop",
      );
      expect(wrapper).toHaveBeenCalledOnce();
    },
  );

  it("keeps qualification across a real model-specific API alias", async () => {
    const registry = createApiRegistry();
    const runtime = createLlmRuntime(registry);
    const existing = terminalDelegate(false);
    const selected = terminalDelegate(true);
    for (const [provider, delegate] of [
      ["existing", existing],
      ["fixture", selected],
    ] as const) {
      const prepared = attachModelProviderRuntimePluginHandle(model, {
        provider: model.provider,
        modelId: model.id,
        plugin: { id: provider, label: provider, auth: [], createStreamFn: () => delegate },
      });
      if (provider === "existing") {
        registerProviderStreamForModel({ model: prepared, apiRegistry: registry });
        continue;
      }
      const alias = prepareModelForSimpleCompletion({ apiRegistry: registry, model: prepared });
      expect(alias.api).not.toBe(model.api);
      const result = await runWithOperatorModelRequest(finiteAuthority(), () =>
        runtime.completeSimple(alias, { messages: [] }),
      );
      expect(result.stopReason).toBe("stop");
      expect(selected).toHaveBeenCalledOnce();
      expect(selected.mock.calls[0]?.[0].api).toBe(model.api);
      expect(existing).not.toHaveBeenCalled();
    }
  });

  it.each(["websocket", "websocket-cached", "auto"] as const)(
    "visibly denies finite Responses %s before socket acquisition",
    async (transport) => {
      const selected = makeProviderModelFixture({
        provider: "openai",
        id: "allowed",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });
      const raw = expectDefined(
        createOpenClawTransportStreamFnForModel(selected),
        "Responses transport",
      );
      const stream = await wrapOperatorModelStream(raw, finiteAuthority())(
        selected,
        { messages: [] },
        {
          apiKey: "fixture-key",
          transport,
          sessionId: "unsupported-finite-socket",
        },
      );
      const events: string[] = [];
      for await (const event of stream) {
        events.push(event.type);
      }
      expect(await stream.result()).toMatchObject({
        stopReason: "error",
        errorCode: "OPERATOR_MODEL_POLICY_DENIED",
        errorMessage: expect.stringContaining("supported HTTP transport"),
      });
      expect(events).toEqual(["error"]);
      expect(socket).not.toHaveBeenCalled();
    },
  );
});
