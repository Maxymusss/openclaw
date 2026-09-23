import { describe, expect, it, vi } from "vitest";
import {
  providerModelRequestBindingSupported,
  readProviderModelRequestBindingSupport,
} from "./provider-model-request-binding.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";

const model = {
  provider: "fixture",
  id: "physical",
  api: "openai-responses",
  baseUrl: "https://example.invalid",
};
const leaf = { contract: "wire-model-v1" as const, transports: ["sse"] as const };
const plugin: ProviderPlugin = { id: "fixture", label: "Fixture", auth: [] };

describe("prepared provider request binding", () => {
  it("publishes the physical leaf transports without a preparing request", () => {
    expect(readProviderModelRequestBindingSupport({ model, plugin, leaf })).toEqual(leaf);
    expect(readProviderModelRequestBindingSupport({ model, plugin })).toBeUndefined();
  });

  it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
    "intersects a factory's physical transports with its %s promise without invoking either",
    (wrapper) => {
      const createStreamFn = vi.fn(() => undefined);
      const wrap = vi.fn(() => undefined);
      const query = vi.fn<NonNullable<ProviderPlugin["resolveModelRequestBindingSupport"]>>(
        ({ transport }) =>
          transport === "sse"
            ? { createStreamFn: "wire-model-v1", [wrapper]: "preserves-delegate" }
            : transport === "websocket"
              ? { createStreamFn: "wire-model-v1" }
              : undefined,
      );
      const installed = {
        ...plugin,
        createStreamFn,
        [wrapper]: wrap,
        resolveModelRequestBindingSupport: query,
      };
      expect(readProviderModelRequestBindingSupport({ model, plugin: installed, wrapper })).toEqual(
        leaf,
      );
      expect(query.mock.calls.map(([context]) => context.transport)).toEqual([
        "sse",
        "websocket",
        "websocket-cached",
        "auto",
      ]);
      expect(createStreamFn).not.toHaveBeenCalled();
      expect(wrap).not.toHaveBeenCalled();
      expect(
        readProviderModelRequestBindingSupport({
          model,
          plugin: { ...installed, resolveModelRequestBindingSupport: () => undefined },
          leaf,
          wrapper,
        }),
      ).toBeUndefined();
    },
  );

  it.each([undefined, "auto", "websocket", "websocket-cached"] as const)(
    "does not infer SSE from %s",
    (transport) => {
      expect(providerModelRequestBindingSupported({ model, plugin, transport, leaf })).toBe(false);
    },
  );

  it.each(["factory", "wrapper"])("reads an absent %s declaration once", (kind) => {
    const query = vi.fn(() => undefined);
    const hook = vi.fn(() => undefined);
    const installed = {
      ...plugin,
      resolveModelRequestBindingSupport: query,
      ...(kind === "factory" ? { createStreamFn: hook } : { wrapStreamFn: hook }),
    };
    expect(
      providerModelRequestBindingSupported({
        model,
        plugin: installed,
        leaf,
        transport: "sse",
        wrapper: "wrapStreamFn",
      }),
    ).toBe(false);
    expect(query).toHaveBeenCalledOnce();
    expect(hook).not.toHaveBeenCalled();
  });

  it("uses the selected leaf only when no factory replaces it", () => {
    const createStreamFn = vi.fn(() => undefined);
    expect(providerModelRequestBindingSupported({ model, transport: "sse", plugin, leaf })).toBe(
      true,
    );
    expect(
      providerModelRequestBindingSupported({
        model,
        transport: "sse",
        plugin: { ...plugin, createStreamFn },
        leaf,
      }),
    ).toBe(false);
    expect(createStreamFn).not.toHaveBeenCalled();
  });

  it("queries only copied secret-free route facts and never constructs a provider", () => {
    const createStreamFn = vi.fn(() => undefined);
    const resolveModelRequestBindingSupport = vi.fn<
      NonNullable<ProviderPlugin["resolveModelRequestBindingSupport"]>
    >((context) => {
      expect(context).toEqual({ model, transport: "sse" });
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.model)).toBe(true);
      return { createStreamFn: "wire-model-v1" };
    });
    const runtimeModel = { ...model, headers: { authorization: "not-for-the-query" } };
    expect(
      providerModelRequestBindingSupported({
        model: runtimeModel,
        transport: "sse",
        plugin: { ...plugin, createStreamFn, resolveModelRequestBindingSupport },
      }),
    ).toBe(true);
    expect(resolveModelRequestBindingSupport).toHaveBeenCalledOnce();
    expect(resolveModelRequestBindingSupport.mock.calls[0]?.[0].model).not.toBe(runtimeModel);
    expect(createStreamFn).not.toHaveBeenCalled();
  });

  it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
    "requires the exact installed %s declaration",
    (wrapper) => {
      const wrap = vi.fn(() => undefined);
      const installed = { ...plugin, [wrapper]: wrap };
      expect(
        providerModelRequestBindingSupported({
          model,
          transport: "sse",
          plugin: installed,
          leaf,
          wrapper,
        }),
      ).toBe(false);
      expect(
        providerModelRequestBindingSupported({
          model,
          transport: "sse",
          leaf,
          wrapper,
          plugin: {
            ...installed,
            resolveModelRequestBindingSupport: () => ({ [wrapper]: "preserves-delegate" }),
          },
        }),
      ).toBe(true);
      expect(wrap).not.toHaveBeenCalled();
    },
  );
});
