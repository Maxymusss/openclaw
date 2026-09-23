import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as authProfileStore from "../auth-profiles/store-runtime.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "./model.generation-scope.test-support.js";
import { buildInlineProviderModels } from "./model.inline-provider.js";
import { resolveModelAsync } from "./model.js";
import { resolveRuntimeHooks } from "./model.provider-hooks.js";

describe("plugin-owned model auth", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    resetModelGenerationFixtureState();
    state = await createOpenClawTestState({
      label: "model-plugin-auth",
      env: { CODEX_HOME: undefined },
    });
    vi.spyOn(authProfileStore, "loadAuthProfileStoreForRuntimeAsync").mockRejectedValue(
      new Error("Plugin-owned model resolution must not read host credentials"),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetModelGenerationFixtureState();
    await state.cleanup();
  });

  it.each([
    {
      source: "static",
      name: "Static PLUGIN-AUTH",
      contextWindow: 200_000,
      maxTokens: 200_000,
      imageMaxSidePx: 1_600,
    },
    {
      source: "configured",
      name: "Configured plugin model",
      contextWindow: 32_768,
      maxTokens: 4_096,
      imageMaxSidePx: 2_048,
    },
  ])("resolves $source metadata without host credential discovery", async (expected) => {
    const provider = "generation-plugin-auth";
    const modelId = "plugin-model";
    const config: OpenClawConfig =
      expected.source === "configured"
        ? {
            models: {
              providers: {
                [provider]: {
                  api: "openai-completions",
                  baseUrl: `https://${provider}.example.test/v1`,
                  models: [
                    {
                      id: modelId,
                      name: "Configured plugin model",
                      reasoning: false,
                      input: ["text", "image"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 32_768,
                      maxTokens: 4_096,
                      mediaInput: { image: { maxSidePx: 2_048 } },
                    },
                  ],
                },
              },
            },
          }
        : {};
    const generation = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config,
      label: "plugin-auth",
      provider,
      requestProvider: provider,
      modelId,
      staticImagePolicy: { maxSidePx: 1_600 },
    });
    publishCurrentModelGeneration(generation);
    const preparedModelRuntime = {
      ...generation.preparedModelRuntime,
      inlineProviderModels: buildInlineProviderModels(config.models?.providers ?? {}),
    };

    const result = await resolveModelAsync(provider, modelId, state.agentDir(), config, {
      ...preparedModelRuntime.createStores(),
      preparedModelRuntime,
      harnessAuthBootstrap: "plugin",
      allowBundledStaticCatalogFallback: true,
      skipAgentDiscovery: true,
      workspaceDir: state.workspaceDir,
      runtimeHooks: {
        ...resolveRuntimeHooks({ skipProviderRuntimeHooks: true }),
        shouldPreferProviderRuntimeResolvedModel: () => true,
      },
    });

    expect(result.model).toMatchObject({
      provider,
      id: modelId,
      name: expected.name,
      api: "openai-completions",
      contextWindow: expected.contextWindow,
      maxTokens: expected.maxTokens,
      mediaInput: { image: { maxSidePx: expected.imageMaxSidePx } },
    });
  });
});
