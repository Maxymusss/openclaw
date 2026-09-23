import { describe, expect, it } from "vitest";
import {
  resolveInitialThinkLevel,
  resolveRequestStreamTransportOverrides,
} from "./runtime-resolution.js";

describe("resolveRequestStreamTransportOverrides", () => {
  it("marks non-empty request stream parameters for OpenClaw routing", () => {
    expect(resolveRequestStreamTransportOverrides({ maxTokens: 64 })).toBe("present");
  });

  it("keeps an empty request stream parameter record on the implicit runtime route", () => {
    expect(resolveRequestStreamTransportOverrides({})).toBeUndefined();
  });
});

describe("resolveInitialThinkLevel", () => {
  it("preserves logical Ultra until the provider runtime boundary", () => {
    expect(
      resolveInitialThinkLevel({
        requested: "ultra",
        config: {},
        provider: "openai",
        modelId: "gpt-5.5",
        model: { reasoning: true },
      }),
    ).toBe("ultra");
  });

  it.each([
    {
      label: "explicitly disabled effort support",
      compat: { supportsReasoningEffort: false, reasoningEffortMap: { max: "custom" } },
      expected: "off",
    },
    {
      label: "empty supported efforts",
      compat: { supportedReasoningEfforts: [], reasoningEffortMap: { max: "custom" } },
      expected: "off",
    },
    {
      label: "provider effort mapping",
      compat: { reasoningEffortMap: { max: "custom" } },
      expected: "max",
    },
    {
      label: "binary thinking format",
      compat: { thinkingFormat: "qwen" as const, supportsReasoningEffort: false },
      expected: "high",
    },
  ])("clamps to the actual model's $label", ({ compat, expected }) => {
    expect(
      resolveInitialThinkLevel({
        requested: "max",
        provider: "openai",
        modelId: "custom-thinking-model",
        agentRuntime: "openclaw",
        model: { api: "openai-completions", reasoning: true, compat },
        clampToModel: true,
      }),
    ).toBe(expected);
  });
});
