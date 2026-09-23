import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPreparedModelRequestBindingReader } from "./prepared-model-request-binding.js";
import { capturePreparedModelRuntimeCatalog } from "./prepared-model-runtime.capture.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { getModelRegistryRuntime } from "./sessions/model-registry-runtime.js";
import { ModelRegistry } from "./sessions/model-registry.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

function fixture(transport = "sse") {
  const model = makeProviderModelFixture<"openai-completions">({
    provider: "fixture",
    id: "allowed",
    api: "openai-completions",
    baseUrl: "https://first.example/v1",
  });
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    models: {
      mode: "replace",
      providers: {
        fixture: { api: "openai-completions", baseUrl: model.baseUrl, models: [model] },
      },
    },
    agents: { defaults: { models: { "fixture/allowed": { params: { transport } } } } },
  };
  const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });
  const authStorage = AuthStorage.inMemory({});
  const registry = ModelRegistry.create(authStorage, "/unused/models.json", {
    config,
    modelsJsonContents: null,
    includePluginCatalogs: false,
    pluginMetadataSnapshot: metadataSnapshot,
  });
  let current = true;
  let published: ReadonlyMap<string, readonly Model[]> | undefined;
  const owner: PreparedModelRuntimeSnapshot = {
    catalogOwner: undefined,
    agentDir: "/unused/agent",
    workspaceDir: "/unused/workspace",
    config,
    observationConfig: config,
    activeProjectKeys: [],
    authModes: {},
    metadataSnapshot,
    pluginRegistry: createEmptyPluginRegistry(),
    isCurrent: () => current,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [model], routeVariants: [model] },
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    readPublishedModels: () => published,
    createStores: () => {
      const capturedAuth = AuthStorage.inMemory({});
      return { authStorage: capturedAuth, modelRegistry: registry.fork(capturedAuth) };
    },
  };
  const read = createPreparedModelRequestBindingReader(owner, registry);
  return {
    model,
    registry,
    read,
    owner: { ...owner, readModelRequestBinding: read },
    retire: () => {
      current = false;
    },
    publish: (next: Model) => {
      published = new Map([[next.provider, [next]]]);
    },
  };
}

const selection = { provider: "fixture", modelId: "allowed" };

describe("prepared physical model request support", () => {
  it.each(["auto", "websocket", "websocket-cached"])(
    "does not substitute SSE for prepared %s",
    (transport) => {
      const f = fixture(transport);
      expect(f.read(selection)).toBe(false);
      expect(f.read({ ...selection, mode: "simple" })).toBe(false);
    },
  );

  it("keeps the embedded boundary constructor distinct from the actual direct-completion leaf", () => {
    const f = fixture();
    expect(f.read(selection)).toBe(true);
    expect(f.read({ ...selection, mode: "simple" })).toBe(true);
    const replacement = vi.fn(() => {
      throw new Error("Support lookup must not invoke a provider");
    });
    f.registry.registerProvider("replacement", { api: f.model.api, streamSimple: replacement });
    expect(f.read(selection)).toBe(true);
    expect(f.read({ ...selection, mode: "simple" })).toBe(false);
    f.publish(f.model);
    const captured = capturePreparedModelRuntimeCatalog(f.owner, f.owner);
    expect(captured.readModelRequestBinding?.({ ...selection, mode: "simple" })).toBe(false);
    expect(
      captured
        .createStores()
        .modelRegistry.getAll()
        .find((entry) => entry.provider === "fixture")?.api,
    ).toBe(f.model.api);
    expect(
      getModelRegistryRuntime(captured.createStores().modelRegistry).apiRegistry.getApiProvider(
        f.model.api,
      )?.modelRequestBindingSupport,
    ).toBeUndefined();
    expect(replacement).not.toHaveBeenCalled();
  });

  it("rebinds support and execution to the same published replacement without changing an older capture", () => {
    const f = fixture();
    const original = capturePreparedModelRuntimeCatalog(f.owner, f.owner);
    expect(
      original.readModelRequestBinding?.({
        ...selection,
        api: f.model.api,
        baseUrl: f.model.baseUrl,
      }),
    ).toBe(true);
    const unqualified = {
      ...f.model,
      api: "anthropic-messages",
      baseUrl: "https://second.example/v1",
    };
    f.publish(unqualified);
    const replaced = capturePreparedModelRuntimeCatalog(f.owner, f.owner);
    const actual = replaced.createStores().modelRegistry.find("fixture", "allowed");
    expect(actual).toMatchObject({ api: unqualified.api, baseUrl: unqualified.baseUrl });
    expect(
      replaced.readModelRequestBinding?.({
        ...selection,
        api: actual?.api,
        baseUrl: actual?.baseUrl,
      }),
    ).toBe(false);
    expect(
      replaced.readModelRequestBinding?.({
        ...selection,
        api: f.model.api,
        baseUrl: f.model.baseUrl,
      }),
    ).toBe(false);
    expect(
      original.readModelRequestBinding?.({
        ...selection,
        api: f.model.api,
        baseUrl: f.model.baseUrl,
      }),
    ).toBe(true);
    const qualified = { ...f.model, baseUrl: "https://third.example/v1" };
    f.publish(qualified);
    const renewed = capturePreparedModelRuntimeCatalog(f.owner, f.owner);
    expect(renewed.createStores().modelRegistry.find("fixture", "allowed")).toMatchObject(
      qualified,
    );
    expect(
      renewed.readModelRequestBinding?.({
        ...selection,
        api: qualified.api,
        baseUrl: qualified.baseUrl,
      }),
    ).toBe(true);
    expect(
      replaced.readModelRequestBinding?.({
        ...selection,
        api: qualified.api,
        baseUrl: qualified.baseUrl,
      }),
    ).toBe(false);
    f.retire();
    expect(original.readModelRequestBinding?.(selection)).toBe(false);
    expect(renewed.readModelRequestBinding?.(selection)).toBe(false);
  });
});
