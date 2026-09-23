// LLM Runtime tests cover api registry behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";
import {
  createApiRegistry,
  createAssistantMessageEventStream,
  createLlmRuntime,
  type Model,
} from "./index.js";
import {
  defaultApiRegistry,
  streamSimple as streamSimpleDefault,
} from "./internal/default-runtime.js";

const initialHost = getAiTransportHost();
const TEST_SOURCE_ID = "test:llm-runtime-api-registry";
const emptyStream = () => createAssistantMessageEventStream();

const model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model;

describe("LLM API registry", () => {
  afterEach(() => {
    defaultApiRegistry.unregisterApiProviders(TEST_SOURCE_ID);
    configureAiTransportHost(initialHost);
  });

  it.each(["stream", "streamSimple"] as const)(
    "%s borrows its captured selection and returns the exact synchronous stream",
    (method) => {
      const runtime = createLlmRuntime();
      const result = emptyStream();
      let inside = false;
      const delegate = vi.fn(() => {
        expect(inside).toBe(true);
        return result;
      });
      const entered = vi.fn();
      const run = <T>(callback: () => T): T => {
        entered();
        inside = true;
        try {
          return callback();
        } finally {
          inside = false;
        }
      };
      const capture = vi.fn(() => ({ run, assertCurrent() {}, bindWireModel: () => () => {} }));
      configureAiTransportHost({ modelRequests: { capture, requireDelegateSupport() {} } });
      runtime.registry.registerApiProvider({
        api: model.api,
        stream: delegate,
        streamSimple: delegate,
      });
      expect(runtime[method](model, { messages: [] })).toBe(result);
      expect(capture).toHaveBeenCalledExactlyOnceWith(model);
      expect(entered).toHaveBeenCalledOnce();
      expect(delegate).toHaveBeenCalledOnce();
      expect(inside).toBe(false);
    },
  );

  it.each(["stream", "streamSimple"] as const)(
    "%s preserves absent and unrestricted capture behavior",
    (method) => {
      const runtime = createLlmRuntime();
      const result = emptyStream();
      const delegate = vi.fn(() => result);
      runtime.registry.registerApiProvider({
        api: model.api,
        stream: delegate,
        streamSimple: delegate,
      });
      for (const modelRequests of [
        undefined,
        { capture: () => undefined, requireDelegateSupport() {} },
      ]) {
        configureAiTransportHost({ modelRequests });
        expect(runtime[method](model, { messages: [] })).toBe(result);
      }
      expect(delegate).toHaveBeenCalledTimes(2);
    },
  );

  it("copies method-specific support and retires it with the exact registration", () => {
    const registry = createApiRegistry();
    const transports: Array<"sse" | "websocket"> = ["sse"];
    const support = { contract: "wire-model-v1" as const, transports };
    registry.registerApiProvider(
      {
        api: "test-api",
        stream: emptyStream,
        streamSimple: emptyStream,
        modelRequestBindingSupport: { streamSimple: support },
      },
      TEST_SOURCE_ID,
    );
    const registered = registry.getApiProvider("test-api");
    transports.push("websocket");
    expect(registered?.modelRequestBindingSupport?.stream).toBeUndefined();
    expect(registered?.modelRequestBindingSupport?.streamSimple).toEqual({
      contract: "wire-model-v1",
      transports: ["sse"],
    });
    expect(Object.isFrozen(registered?.modelRequestBindingSupport?.streamSimple?.transports)).toBe(
      true,
    );
    registry.registerApiProvider(
      { api: "test-api", stream: emptyStream, streamSimple: emptyStream },
      TEST_SOURCE_ID,
    );
    expect(registry.getApiProvider("test-api")).not.toBe(registered);
    expect(registry.getApiProvider("test-api")?.modelRequestBindingSupport).toBeUndefined();
    registry.unregisterApiProviders(TEST_SOURCE_ID);
    expect(registry.getApiProvider("test-api")).toBeUndefined();
  });

  it("rejects mismatched model API calls", () => {
    const registry = createApiRegistry();
    registry.registerApiProvider(
      {
        api: "test-api",
        stream: emptyStream,
        streamSimple: emptyStream,
      },
      TEST_SOURCE_ID,
    );

    const provider = registry.getApiProvider("test-api");
    expect(() => provider?.streamSimple({ ...model, api: "other-api" }, { messages: [] })).toThrow(
      "Mismatched api: other-api expected test-api",
    );
  });

  it("isolates providers between runtime instances", () => {
    const first = createLlmRuntime();
    const second = createLlmRuntime();
    const streamSimple = vi.fn(() => createAssistantMessageEventStream());
    first.registry.registerApiProvider({ api: "test-api", stream: streamSimple, streamSimple });

    first.streamSimple(model, { messages: [] });

    expect(streamSimple).toHaveBeenCalledOnce();
    expect(() => second.streamSimple(model, { messages: [] })).toThrow(
      "No API provider registered for api: test-api",
    );
  });

  it("shares default runtime registrations across duplicated module instances", async () => {
    // File URLs preserve the cache-busting query through Vitest project shards.
    // Computed relative imports can escape into unresolved Vite /@fs paths.
    const duplicateRuntime = (await import(
      /* @vite-ignore */ new URL("./internal/default-runtime.ts?duplicate-runtime", import.meta.url)
        .href
    )) as typeof import("./internal/default-runtime.js");
    const streamSimple = vi.fn(emptyStream);
    duplicateRuntime.defaultApiRegistry.registerApiProvider(
      {
        api: "test-api",
        stream: emptyStream,
        streamSimple,
      },
      TEST_SOURCE_ID,
    );

    streamSimpleDefault(model, { messages: [] });

    expect(streamSimple).toHaveBeenCalledOnce();
  });

  it("unregisters every provider owned by one source", () => {
    const registry = createApiRegistry();
    for (const api of ["test-api", "test-api-2"] as const) {
      registry.registerApiProvider(
        {
          api,
          stream: emptyStream,
          streamSimple: emptyStream,
        },
        TEST_SOURCE_ID,
      );
    }

    registry.unregisterApiProviders(TEST_SOURCE_ID);

    expect(registry.getApiProviders()).toEqual([]);
  });
});
