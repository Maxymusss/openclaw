import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveRuntimeModelRef } from "./codex-route-model-ref.js";

describe("Doctor configured alias routes", () => {
  it.each([
    { scope: "default", agentModels: undefined, name: "EXTRA", expected: "openai/gpt-5.4-mini" },
    {
      scope: "agent",
      agentModels: { "openai/gpt-5.4-mini": { aliases: ["worker"] } },
      name: "WORKER",
      expected: "openai/gpt-5.4-mini",
    },
    {
      scope: "disabled",
      agentModels: { "openai/gpt-5.4-mini": { aliases: [] } },
      name: "extra",
      expected: "anthropic/extra",
    },
  ])("resolves $scope aliases before runtime inference", ({ agentModels, name, expected }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          models: { "openai/gpt-5.4-mini": { alias: "primary", aliases: ["extra"] } },
        },
        entries: { worker: { models: agentModels } },
      },
    };
    expect(resolveRuntimeModelRef({ cfg, agentId: "worker", modelRef: name })).toBe(expected);
  });
});
