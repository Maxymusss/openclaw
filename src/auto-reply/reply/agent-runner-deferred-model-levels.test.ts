import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { useBundledProviderPolicyArtifactsForTest } from "../../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import { createReplyModelLevelResolver } from "./reply-model-levels.js";

useBundledProviderPolicyArtifactsForTest(["openai", "anthropic"]);
const state = await setupAgentRunnerExecutionTestState();

describe("deferred thinking across actual fallback owners", () => {
  it("keeps the original default after a clamped candidate and reports each effective level", async () => {
    const followupRun = createFollowupRun();
    Object.assign(followupRun.run, {
      provider: "openai",
      model: "gpt-5.6-sol",
      thinkLevel: undefined,
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
              "demo/basic": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
    });
    followupRun.run.deferredReplyModelLevels = createReplyModelLevelResolver({
      modelState: createModelSelectionStateFixture({
        provider: "openai",
        model: "gpt-5.6-sol",
        agentCfg: { thinkingDefault: "ultra" },
      }),
      selection: {
        provider: "openai",
        model: "gpt-5.6-sol",
        thinkingExplicit: false,
        reasoningLevel: "off",
        reasoningExplicit: false,
      },
    }).defer();
    const onModelSelected = vi.fn();
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("demo", "basic", initialFallbackAttemptOptions(params));
      expect(followupRun.run.thinkLevel).toBe("ultra");
      expect(followupRun.run.effectiveThinkLevel).toBe("high");
      expect(followupRun.run.deferredReplyModelLevels).toBeUndefined();
      const result = await params.run(
        "openai",
        "gpt-5.6-sol",
        fallbackAttemptOptions(params, "unknown"),
      );
      return { result, provider: "openai", model: "gpt-5.6-sol", attempts: [] };
    });
    state.runEmbeddedAgentMock
      .mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
        expect(params.deferredReplyModelLevels).toBeDefined();
        params.onReplyModelLevelsResolved?.({
          provider: "demo",
          model: "basic",
          originalThinkLevel: "ultra",
          thinkLevel: "high",
          reasoningLevel: "off",
        });
        return { payloads: [{ text: "first" }], meta: {} };
      })
      .mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
        expect(params.deferredReplyModelLevels).toBeUndefined();
        expect(params.thinkLevel).toBe("ultra");
        params.onReplyModelLevelsResolved?.({
          provider: "openai",
          model: "gpt-5.6-sol",
          thinkLevel: "ultra",
          reasoningLevel: "off",
        });
        return { payloads: [{ text: "second" }], meta: {} };
      });
    const execute = await getExecuteAgentTurnForTest();
    await execute(createMinimalRunAgentTurnParams({ followupRun, opts: { onModelSelected } }));
    expect(followupRun.run.thinkLevel).toBe("ultra");
    expect(followupRun.run.effectiveThinkLevel).toBe("ultra");
    expect(onModelSelected.mock.calls.map(([selection]) => selection.thinkLevel)).toEqual([
      "high",
      "ultra",
    ]);
  });
});
