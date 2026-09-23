import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import {
  createOpenClawTransportStreamFnForModel,
  prepareModelForSimpleCompletion,
} from "@openclaw/ai/transports";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  attachModelProviderRuntimePluginHandle,
  getModelProviderRuntimePluginHandle,
} from "../plugins/provider-hook-runtime.js";
import type {
  PluginProviderRegistration,
  ProviderPlugin,
} from "../plugins/provider-plugin.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { SECRET_SENTINEL_PREFIX, SECRET_SENTINEL_SUFFIX } from "../secrets/sentinel.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { resolveCompactionProviderStream } from "./embedded-agent-runner/compaction-diagnostics.js";
import {
  applyExtraParamsToAgent,
  resolvePreparedExtraParams,
  resolveAgentTransportOverride,
  resolveSupportedTransport,
} from "./embedded-agent-runner/extra-params.js";
import { wrapStreamFnWithMessageTransform } from "./embedded-agent-runner/run/message-transform-stream-wrapper.js";
import {
  prepareOperatorModelPolicy,
  captureOperatorModelRequest,
  runWithOperatorModelRequest,
  wrapOperatorModelStream,
} from "./operator-model-policy.js";
import { wrapStreamFnTextTransforms } from "./plugin-text-transforms.js";
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

function finiteAuthority(assertCurrent: () => void = () => {}) {
  return createAdmittedRunOperatorAuthority({
    profileId: "transport-operator",
    scopes: ["operator.sessions.write"],
    modelPolicy: prepareOperatorModelPolicy({
      cfg: {},
      policy: { allow: ["fixture/allowed", "openai/allowed"] },
      manifestPlugins: [],
    }),
    assertCurrent,
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
  let buildOpenAIProvider: () => ProviderPlugin;
  beforeAll(async () => {
    ({ buildOpenAIProvider } = await loadBundledPluginFacade<{
      buildOpenAIProvider: () => ProviderPlugin;
    }>({ pluginId: "openai", artifactBasename: "api.js" }));
  });

  beforeEach(() => {
    socket.mockClear();
  });

  it.each(["embedded", "simple"] as const)(
    "keeps the first %s factory delegate across staff/finite preparation order",
    async (kind) => {
      for (const firstFinite of [false, true]) {
        for (const staffTransport of [undefined, "auto"] as const) {
          const apiRegistry = createApiRegistry();
          const runtime = createLlmRuntime(apiRegistry);
          if (kind === "simple") {
            ensureCustomApiRegistered(apiRegistry, model.api, terminalDelegate(false));
          }
          const firstDelegate = terminalDelegate(true);
          const secondDelegate = terminalDelegate(true);
          const factory = vi
            .fn<NonNullable<ProviderPlugin["createStreamFn"]>>()
            .mockReturnValueOnce(firstDelegate)
            .mockReturnValueOnce(secondDelegate);
          const prepared = attachModelProviderRuntimePluginHandle(model, {
            provider: model.provider,
            modelId: model.id,
            plugin: {
              id: "fixture",
              label: "Fixture",
              auth: [],
              createStreamFn: factory,
              wrapSimpleCompletionStreamFn: ({ streamFn }) => streamFn,
              resolveModelRequestBindingSupport: ({ model: route, transport }) =>
                route.provider === model.provider &&
                route.id === model.id &&
                route.api === model.api &&
                route.baseUrl === model.baseUrl &&
                transport === "sse"
                  ? {
                      createStreamFn: "wire-model-v1",
                      wrapSimpleCompletionStreamFn: "preserves-delegate",
                    }
                  : undefined,
            },
          });
          const authority = finiteAuthority();
          const prepare = (finite: boolean) =>
            runWithOperatorModelRequest(finite ? authority : undefined, () => {
              const transport = finite ? "sse" : staffTransport;
              if (kind === "simple") {
                return prepareModelForSimpleCompletion({ model: prepared, apiRegistry, transport });
              }
              registerProviderStreamForModel({
                model: prepared,
                apiRegistry,
                preparedTransport: transport,
              });
              return prepared;
            });
          const first = prepare(firstFinite);
          const registration = expectDefined(
            apiRegistry.getApiProvider(first.api),
            "first delegate registration",
          );
          const second = prepare(!firstFinite);
          expect(second.api).toBe(first.api);
          expect(apiRegistry.getApiProvider(second.api)).toBe(registration);
          for (const finite of [true, false]) {
            expect(
              (
                await runWithOperatorModelRequest(finite ? authority : undefined, () =>
                  runtime.completeSimple(second, { messages: [] }, { transport: "sse" }),
                )
              ).stopReason,
            ).toBe("stop");
          }
          expect(factory).toHaveBeenCalledTimes(2);
          expect(firstDelegate).toHaveBeenCalledTimes(2);
          expect(secondDelegate).not.toHaveBeenCalled();
          expect(registration.streamSimple.modelRequestBinding).toBe("wire-model-v1");
          expect(registration.modelRequestBindingSupport?.streamSimple?.transports).toEqual([
            "sse",
          ]);
          apiRegistry.clearApiProviders();
        }
      }
    },
  );

  it.each(["registration", "hook"] as const)(
    "retains the raw direct-completion provider handle across %s replacement",
    async (replacement) => {
      const delegate = terminalDelegate(true);
      const factory = vi.fn(() => delegate);
      const registration: PluginProviderRegistration = {
        pluginId: "fixture",
        source: "/fixture/index.js",
        provider: {
          id: "fixture",
          label: "Fixture",
          auth: [],
          createStreamFn: factory,
          resolveModelRequestBindingSupport: () => ({ createStreamFn: "wire-model-v1" }),
        },
      };
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.providers.push(registration);
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture",
            providers: ["fixture"],
            source: registration.source,
            rootDir: "/fixture",
          },
        ],
      });
      const apiRegistry = createApiRegistry();
      const authority = finiteAuthority();
      expect(getModelProviderRuntimePluginHandle(model)).toBeUndefined();
      const prepared = withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () =>
        runWithOperatorModelRequest(authority, () =>
          prepareModelForSimpleCompletion({
            model,
            apiRegistry,
            transport: "sse",
            cfg: { plugins: { enabled: true, allow: ["fixture"] } },
          }),
        ),
      );
      const handle = expectDefined(
        getModelProviderRuntimePluginHandle(prepared),
        "prepared provider runtime handle",
      );
      expect(handle.plugin?.createStreamFn).toBe(factory);
      expect(handle.isModelRequestBindingCurrent?.()).toBe(true);
      const runtime = createLlmRuntime(apiRegistry);
      const dispatch = () =>
        runtime.completeSimple(prepared, { messages: [] }, { transport: "sse" });
      expect((await runWithOperatorModelRequest(authority, dispatch)).stopReason).toBe("stop");
      if (replacement === "registration") {
        pluginRegistry.providers[0] = { ...registration, provider: { ...registration.provider } };
      } else {
        registration.provider.createStreamFn = () => delegate;
      }
      expect(handle.isModelRequestBindingCurrent?.()).toBe(false);
      await expect(runWithOperatorModelRequest(authority, dispatch)).rejects.toThrow(
        "cannot enforce your model restrictions",
      );
      expect(delegate).toHaveBeenCalledOnce();
      expect((await dispatch()).stopReason).toBe("stop");
      expect(delegate).toHaveBeenCalledTimes(2);
      expect(factory).toHaveBeenCalledOnce();
    },
  );

  it.each(["sse", "websocket", "auto", "unknown"] as const)(
    "checks selected %s before the embedded factory and wrapper despite an SSE default",
    (selectedTransport) => {
      const leaf = terminalDelegate(true);
      const factory = vi.fn(() => leaf);
      const wrapper = vi.fn(() => leaf);
      const prepared = attachModelProviderRuntimePluginHandle(model, {
        provider: model.provider,
        modelId: model.id,
        plugin: {
          id: "fixture",
          label: "Fixture",
          auth: [],
          createStreamFn: factory,
          wrapStreamFn: wrapper,
          resolveModelRequestBindingSupport: ({ transport }) =>
            transport === "sse"
              ? { createStreamFn: "wire-model-v1", wrapStreamFn: "preserves-delegate" }
              : undefined,
        },
      });
      const settingsManager = {
        getGlobalSettings: () => ({ transport: "sse" as const }),
        getProjectSettings: () => ({}),
      };
      const effectiveExtraParams = { transport: "sse" };
      const effectiveAgentTransport =
        resolveAgentTransportOverride({ settingsManager, effectiveExtraParams }) ??
        selectedTransport;
      const preparedTransport = resolveSupportedTransport(effectiveAgentTransport);
      const construct = () =>
        registerProviderStreamForModel({
          model: prepared,
          preparedExtraParams: effectiveExtraParams,
          preparedTransport,
        });
      const wrap = (operatorAuthority = finiteAuthority()) =>
        applyExtraParamsToAgent(
          { streamFn: leaf },
          undefined,
          model.provider,
          model.id,
          undefined,
          undefined,
          undefined,
          undefined,
          prepared,
          undefined,
          undefined,
          { preparedExtraParams: effectiveExtraParams, preparedTransport, operatorAuthority },
        );
      if (selectedTransport === "sse") {
        runWithOperatorModelRequest(finiteAuthority(), construct);
        wrap();
        expect(factory).toHaveBeenCalledOnce();
        expect(wrapper).toHaveBeenCalledOnce();
      } else {
        expect(() => runWithOperatorModelRequest(finiteAuthority(), construct)).toThrow(
          "cannot enforce your model restrictions",
        );
        expect(wrap).toThrow("cannot enforce your model restrictions");
        expect(factory).not.toHaveBeenCalled();
        expect(wrapper).not.toHaveBeenCalled();
      }
      const beforeFactory = factory.mock.calls.length;
      const beforeWrapper = wrapper.mock.calls.length;
      construct();
      applyExtraParamsToAgent(
        { streamFn: leaf },
        undefined,
        model.provider,
        model.id,
        undefined,
        undefined,
        undefined,
        undefined,
        prepared,
        undefined,
        undefined,
        { preparedExtraParams: effectiveExtraParams, preparedTransport },
      );
      expect(factory).toHaveBeenCalledTimes(beforeFactory + 1);
      expect(wrapper).toHaveBeenCalledTimes(beforeWrapper + 1);
      expect(leaf).not.toHaveBeenCalled();
    },
  );

  it("refuses finite auto compaction before its factory while preserving staff construction", () => {
    const factory = vi.fn(() => terminalDelegate(true));
    const prepared = attachModelProviderRuntimePluginHandle(model, {
      provider: model.provider,
      modelId: model.id,
      plugin: {
        id: "fixture",
        label: "Fixture",
        auth: [],
        createStreamFn: factory,
        prepareExtraParams: () => ({ transport: "sse" }),
        resolveModelRequestBindingSupport: ({ transport }) =>
          transport === "sse" ? { createStreamFn: "wire-model-v1" } : undefined,
      },
    });
    const construct = () =>
      resolveCompactionProviderStream({
        effectiveModel: prepared,
        agentDir: "/fixture/agent",
        effectiveWorkspace: "/fixture/workspace",
        apiRegistry: createApiRegistry(),
        preparedTransport: "auto",
      });
    expect(() => runWithOperatorModelRequest(finiteAuthority(), construct)).toThrow(
      "cannot enforce your model restrictions",
    );
    expect(factory).not.toHaveBeenCalled();
    expect(construct()).toBeTypeOf("function");
    expect(factory).toHaveBeenCalledOnce();
  });

  it.each(["embedded", "simple"] as const)(
    "refuses an unknown %s factory before credential unwrap or invocation",
    (kind) => {
      const factory = vi.fn(() => terminalDelegate(true));
      const prepared = attachModelProviderRuntimePluginHandle(
        {
          ...model,
          headers: { "x-key": `${SECRET_SENTINEL_PREFIX}invalid${SECRET_SENTINEL_SUFFIX}` },
        },
        {
          provider: model.provider,
          modelId: model.id,
          plugin: { id: "fixture", label: "Fixture", auth: [], createStreamFn: factory },
        },
      );
      const registry = createApiRegistry();
      const prepare = () =>
        kind === "embedded"
          ? registerProviderStreamForModel({
              model: prepared,
              apiRegistry: registry,
              preparedExtraParams: { transport: "sse" },
            })
          : prepareModelForSimpleCompletion({
              model: prepared,
              apiRegistry: registry,
              transport: "sse",
            });
      expect(() => runWithOperatorModelRequest(finiteAuthority(), prepare)).toThrow(
        "cannot enforce your model restrictions",
      );
      expect(prepare).toThrow("Secret sentinel");
      expect(factory).not.toHaveBeenCalled();
      expect(registry.getApiProvider(model.api)).toBeUndefined();
    },
  );

  it.each(["embedded", "simple"] as const)(
    "treats an opted-in %s null factory as terminal before fallback",
    (kind) => {
      const factory = vi.fn(() => undefined);
      const prepared = attachModelProviderRuntimePluginHandle(model, {
        provider: model.provider,
        modelId: model.id,
        plugin: {
          id: "fixture",
          label: "Fixture",
          auth: [],
          createStreamFn: factory,
          resolveModelRequestBindingSupport: () => ({ createStreamFn: "wire-model-v1" }),
        },
      });
      const registry = createApiRegistry();
      const prepare = () =>
        kind === "embedded"
          ? registerProviderStreamForModel({
              model: prepared,
              apiRegistry: registry,
              preparedExtraParams: { transport: "sse" },
            })
          : prepareModelForSimpleCompletion({
              model: prepared,
              apiRegistry: registry,
              transport: "sse",
            });
      expect(() => runWithOperatorModelRequest(finiteAuthority(), prepare)).toThrow(
        "no qualified model request delegate",
      );
      expect(factory).toHaveBeenCalledOnce();
      expect(registry.getApiProvider(model.api)).toBeUndefined();
      expect(prepare()).toBe(kind === "embedded" ? undefined : prepared);
      expect(factory).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps a registry constructed under guest A neutral for guest B and staff", async () => {
    let active = true;
    const guestA = finiteAuthority(() => {
      if (!active) {
        throw new Error("guest A revoked");
      }
    });
    const guestB = finiteAuthority();
    const registry = createApiRegistry();
    const runtime = createLlmRuntime(registry);
    const delegate = terminalDelegate(true);
    const factory = vi.fn(() => delegate);
    const prepared = attachModelProviderRuntimePluginHandle(model, {
      provider: model.provider,
      modelId: model.id,
      plugin: {
        id: "fixture",
        label: "Fixture",
        auth: [],
        createStreamFn: factory,
        resolveModelRequestBindingSupport: () => ({ createStreamFn: "wire-model-v1" }),
      },
    });
    runWithOperatorModelRequest(guestA, () =>
      registerProviderStreamForModel({
        model: prepared,
        apiRegistry: registry,
        preparedExtraParams: { transport: "sse" },
      }),
    );
    const dispatch = () => runtime.completeSimple(model, { messages: [] }, { transport: "sse" });
    expect((await runWithOperatorModelRequest(guestA, dispatch)).stopReason).toBe("stop");
    active = false;
    await expect(runWithOperatorModelRequest(guestB, dispatch)).resolves.toMatchObject({
      stopReason: "stop",
    });
    await expect(dispatch()).resolves.toMatchObject({ stopReason: "stop" });
    expect(() => runWithOperatorModelRequest(guestA, dispatch)).toThrow("guest A revoked");
    expect(factory).toHaveBeenCalledOnce();
    expect(delegate).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "preserves the real OpenAI SSE wrapper chain and original authority across lazy import (revoke=%s)",
    async (revoke) => {
      let active = true;
      const authority = finiteAuthority(() => {
        if (!active) {
          throw new Error("original source revoked");
        }
      });
      const selected = attachModelProviderRuntimePluginHandle(
        makeProviderModelFixture({
          provider: "openai",
          id: "allowed",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        }),
        { provider: "openai", modelId: "allowed", plugin: buildOpenAIProvider() },
      );
      const leaf = terminalDelegate(true);
      const agent = {
        streamFn: wrapStreamFnTextTransforms({
          streamFn: wrapOperatorModelStream(leaf, authority),
          input: [{ from: /before/g, to: "after" }],
        }),
      };
      const extraParams = resolvePreparedExtraParams({
        cfg: undefined,
        provider: selected.provider,
        modelId: selected.id,
        model: selected,
      });
      expect(extraParams.transport).toBe("sse");
      applyExtraParamsToAgent(
        agent,
        undefined,
        selected.provider,
        selected.id,
        undefined,
        undefined,
        undefined,
        undefined,
        selected,
        undefined,
        undefined,
        { operatorAuthority: authority, preparedExtraParams: extraParams },
      );
      const transformed = wrapStreamFnWithMessageTransform(agent.streamFn, (messages) => messages);
      expect(transformed.modelRequestBinding).toBe("wire-model-v1");
      const pending = wrapOperatorModelStream(transformed, authority)(selected, {
        messages: [],
        systemPrompt: "before",
      });
      if (revoke) {
        active = false;
        await expect(pending).rejects.toThrow("original source revoked");
        expect(leaf).not.toHaveBeenCalled();
      } else {
        expect((await (await pending).result()).stopReason).toBe("stop");
        expect(leaf).toHaveBeenCalledOnce();
        expect(leaf.mock.calls[0]?.[0]).toBe(selected);
        expect(leaf.mock.calls[0]?.[1].systemPrompt).toBe("after");
        expect(leaf.mock.calls[0]?.[2]).toMatchObject({ transport: "sse" });
      }
    },
  );

  it.each([
    { api: "openai-chatgpt-responses", transport: "sse" as const },
    { api: "openai-responses", transport: "auto" as const },
    { api: "openai-responses", transport: "websocket" as const },
  ])("does not qualify the OpenAI $api/$transport wrapper route", ({ api, transport }) => {
    const plugin = buildOpenAIProvider();
    const selected = attachModelProviderRuntimePluginHandle(
      makeProviderModelFixture({
        provider: "openai",
        id: "allowed",
        api,
        baseUrl: "https://api.openai.com/v1",
      }),
      { provider: "openai", modelId: "allowed", plugin },
    );
    expect(
      plugin.resolveModelRequestBindingSupport?.({ model: selected, transport }),
    ).toBeUndefined();
    const leaf = terminalDelegate(true);
    const agent = { streamFn: leaf };
    expect(() =>
      applyExtraParamsToAgent(
        agent,
        undefined,
        selected.provider,
        selected.id,
        undefined,
        undefined,
        undefined,
        undefined,
        selected,
        undefined,
        undefined,
        { operatorAuthority: finiteAuthority(), preparedExtraParams: { transport } },
      ),
    ).toThrow("cannot enforce your model restrictions");
    expect(leaf).not.toHaveBeenCalled();
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
          plugin: {
            id: "fixture",
            label: "Fixture",
            auth: [],
            createStreamFn: () => delegate,
            resolveModelRequestBindingSupport: () => ({ createStreamFn: "wire-model-v1" }),
          },
        });
        registerProviderStreamForModel({
          model: prepared,
          apiRegistry: registry,
          preparedExtraParams: { transport: "sse" },
        });
      };
      register(qualified);
      const accepted = runWithOperatorModelRequest(finiteAuthority(), () =>
        dispatcher(model, { messages: [] }, { transport: "sse" }),
      );
      expect((await accepted.result()).stopReason).toBe("stop");
      expect(qualified).toHaveBeenCalledOnce();
      register(unsupported);
      expect(() =>
        runWithOperatorModelRequest(finiteAuthority(), () =>
          dispatcher(model, { messages: [] }, { transport: "sse" }),
        ),
      ).toThrow(/cannot bind/);
      expect(unsupported).not.toHaveBeenCalled();
      expect(
        (await dispatcher(model, { messages: [] }, { transport: "sse" }).result()).stopReason,
      ).toBe("stop");
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
          resolveModelRequestBindingSupport: () => ({
            createStreamFn: "wire-model-v1",
            wrapStreamFn: "preserves-delegate",
            wrapSimpleCompletionStreamFn: "preserves-delegate",
          }),
          ...(kind === "embedded-wrapper"
            ? { wrapStreamFn: () => wrapper }
            : { wrapSimpleCompletionStreamFn: () => wrapper }),
        },
      });
      const dispatchModel =
        kind === "simple-wrapper"
          ? prepareModelForSimpleCompletion({
              apiRegistry: registry,
              model: prepared,
              transport: "sse",
            })
          : prepared;
      if (kind === "embedded-wrapper") {
        registerProviderStreamForModel({
          model: prepared,
          apiRegistry: registry,
          wrapProviderStream: true,
          preparedExtraParams: { transport: "sse" },
        });
      }
      expect(() =>
        runWithOperatorModelRequest(finiteAuthority(), () =>
          runtime.streamSimple(dispatchModel, { messages: [] }, { transport: "sse" }),
        ),
      ).toThrow(/cannot bind/);
      expect(wrapper).not.toHaveBeenCalled();
      expect(raw).not.toHaveBeenCalled();
      expect(
        (await runtime.completeSimple(dispatchModel, { messages: [] }, { transport: "sse" }))
          .stopReason,
      ).toBe("stop");
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
        plugin: {
          id: provider,
          label: provider,
          auth: [],
          createStreamFn: () => delegate,
          resolveModelRequestBindingSupport: () => ({ createStreamFn: "wire-model-v1" }),
        },
      });
      if (provider === "existing") {
        registerProviderStreamForModel({
          model: prepared,
          apiRegistry: registry,
          preparedExtraParams: { transport: "sse" },
        });
        continue;
      }
      const alias = prepareModelForSimpleCompletion({
        apiRegistry: registry,
        model: prepared,
        transport: "sse",
      });
      expect(alias.api).not.toBe(model.api);
      const result = await runWithOperatorModelRequest(finiteAuthority(), () =>
        runtime.completeSimple(alias, { messages: [] }, { transport: "sse" }),
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
