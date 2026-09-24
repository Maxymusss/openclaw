import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resetUsageFormatCachesForTest, resolveModelCostConfig } from "../utils/usage-format.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "./remote-overlay.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const passthrough = { passthroughProviderModel: true } as const;

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-v2-standalone-"));
  resetUsageFormatCachesForTest();
  vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot").mockReturnValue(
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "gateway",
          providers: ["gateway"],
          modelPricing: {
            providers: { gateway: { openRouter: passthrough, liteLLM: passthrough } },
          },
        },
        {
          id: "router",
          providers: ["router"],
          modelPricing: { providers: { router: { openRouter: passthrough, liteLLM: false } } },
        },
        {
          id: "litegate",
          providers: ["litegate"],
          modelPricing: { providers: { litegate: { openRouter: false, liteLLM: passthrough } } },
        },
        { id: "vendor", providers: ["vendor"] },
        {
          id: "owner",
          providers: ["owner"],
          modelPricing: { providers: { owner: { openCode: {} } } },
        },
      ],
    }),
  );
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: () => 100,
    readStoredCatalog: () => ({
      id: 1,
      source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
      bundle_json: JSON.stringify({
        schemaVersion: 2,
        generatedAt: 200,
        sourceCommit: "v2-standalone-test",
        providers: { vendor: {} },
        models: [{ id: "catalogued", provider: "vendor", pricing: { status: "unknown" } }],
        upstreamPricing: {
          "vendor/listed": {
            input: 2,
            output: 4,
            source: "openRouter",
            alternatives: [{ input: 2.5, output: 5, source: "liteLLM" }],
          },
          "vendor/litellm-only": { input: 1, output: 3, source: "liteLLM" },
          "vendor/catalogued": {
            input: 5,
            output: 10,
            source: "openRouter",
            passthroughOnly: true,
          },
        },
        providerPricing: {
          "owner/extra": { input: 6, output: 12, source: "openCode" },
          "owner/free": { input: 0, output: 0, source: "openCode" },
        },
      }),
      generated_at: 200,
      min_version: null,
      etag: null,
      last_modified: null,
      checked_at: 200,
    }),
  });
});

afterEach(() => {
  resetUsageFormatCachesForTest();
  setRemoteModelCatalogOverlaySourcesForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const rates = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

it.each([
  { name: "gateway passes through a vendor rate", ref: "gateway/vendor/listed", cost: rates(2, 4) },
  {
    name: "gateway accepts its allowed LiteLLM source",
    ref: "gateway/vendor/litellm-only",
    cost: rates(1, 3),
  },
  { name: "router rejects a source its policy disables", ref: "router/vendor/litellm-only" },
  {
    name: "router passes through its allowed source",
    ref: "router/vendor/listed",
    cost: rates(2, 4),
  },
  {
    name: "LiteLLM-only gateway uses the LiteLLM alternative",
    ref: "litegate/vendor/listed",
    cost: rates(2.5, 5),
  },
  {
    name: "gateway reads rates owned by a catalog row",
    ref: "gateway/vendor/catalogued",
    cost: rates(5, 10),
  },
  {
    name: "direct vendor lookup reads its own upstream rate",
    ref: "vendor/listed",
    cost: rates(2, 4),
  },
  { name: "unknown catalog row is not revived by upstream", ref: "vendor/catalogued" },
  { name: "owner reads its provider-owned rate", ref: "owner/extra", cost: rates(6, 12) },
  { name: "authoritative owner keeps a native free rate", ref: "owner/free", cost: rates(0, 0) },
])("$name", ({ ref, cost }) => {
  const slash = ref.indexOf("/");
  expect(
    resolveModelCostConfig({
      config: {},
      provider: ref.slice(0, slash),
      model: ref.slice(slash + 1),
    }),
  ).toEqual(cost);
});
