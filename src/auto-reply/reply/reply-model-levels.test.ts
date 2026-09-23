import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import {
  createReplyModelLevelResolver,
  resolveDeferredReplyModelLevels,
} from "./reply-model-levels.js";

const loadCatalog = vi.hoisted(() => vi.fn());
vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: loadCatalog,
}));

beforeEach(() => {
  loadCatalog
    .mockReset()
    .mockResolvedValue([{ provider: "fixture", id: "model", name: "Model", reasoning: true }]);
});

describe("deferred reply model intent", () => {
  it.each([undefined, "high"] as const)(
    "captures configured default %s without optional discovery",
    async (configured) => {
      const modelState = createModelSelectionStateFixture({
        provider: "fixture",
        model: "model",
        agentCfg: configured ? { thinkingDefault: configured } : undefined,
      });
      const resolveDefaultThinkingLevel = vi.fn(modelState.resolveDefaultThinkingLevel);
      const resolver = createReplyModelLevelResolver({
        modelState: { ...modelState, resolveDefaultThinkingLevel },
        selection: {
          provider: "fixture",
          model: "model",
          thinkingExplicit: false,
          reasoningLevel: "off",
          reasoningExplicit: false,
        },
      });
      const deferred = resolver.defer();
      expect(resolveDefaultThinkingLevel).not.toHaveBeenCalled();
      expect(loadCatalog).not.toHaveBeenCalled();
      expect(Object.hasOwn(deferred.thinking, "configuredThinkingDefault")).toBe(true);
      const result = await resolveDeferredReplyModelLevels({
        cfg: { agents: { defaults: { thinkingDefault: "off" } } },
        agentId: "main",
        deferred,
      });
      expect(result).toMatchObject({ kind: "ready", thinkLevel: configured ?? "medium" });
      expect(loadCatalog).toHaveBeenCalledOnce();
    },
  );

  it("keeps command resolution lazy and uses the command's existing default owner", async () => {
    const modelState = createModelSelectionStateFixture({
      provider: "fixture",
      model: "model",
      agentCfg: { thinkingDefault: "low" },
    });
    const resolveDefaultThinkingLevel = vi.fn(modelState.resolveDefaultThinkingLevel);
    const resolver = createReplyModelLevelResolver({
      modelState: { ...modelState, resolveDefaultThinkingLevel },
      selection: {
        provider: "fixture",
        model: "model",
        thinkingExplicit: false,
        reasoningLevel: "off",
        reasoningExplicit: false,
      },
    });
    expect(resolveDefaultThinkingLevel).not.toHaveBeenCalled();
    await expect(resolver()).resolves.toMatchObject({ resolvedThinkLevel: "low" });
    await resolver();
    expect(resolveDefaultThinkingLevel).toHaveBeenCalledOnce();
    expect(loadCatalog).not.toHaveBeenCalled();
  });
});
