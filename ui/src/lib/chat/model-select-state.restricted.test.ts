// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  resolveChatModelSelectState,
  resolveChatModelUnavailableReason,
} from "./model-select-state.ts";

const catalog = [{ id: "allowed", provider: "fixture", name: "Allowed", available: true }];

describe("authoritative restricted model catalogs", () => {
  it.each(["session", "override", "agent", "defaults"] as const)(
    "does not reconstruct a hidden %s model",
    (source) => {
      const sessionsResult = createSessionsListResult({
        model: source === "session" ? "hidden" : null,
        modelProvider: "fixture",
        defaultsModel: source === "defaults" ? "hidden" : null,
        defaultsProvider: "fixture",
      });
      const input = {
        sessionKey: "main",
        activeSession: sessionsResult.sessions[0],
        sessionsResult,
        modelOverrides: source === "override" ? { main: "fixture/hidden" } : {},
        agentDefaultModel: source === "agent" ? "fixture/hidden" : undefined,
        chatModelCatalog: catalog,
      };
      const restricted = resolveChatModelSelectState({ ...input, modelRestricted: true });
      expect(restricted.currentOverride).toBe("");
      expect(restricted.defaultModel).toBe("");
      expect(restricted.options).toHaveLength(1);
      const unrestricted = resolveChatModelSelectState(input);
      expect(
        source === "session" || source === "override"
          ? unrestricted.currentOverride
          : unrestricted.defaultModel,
      ).toBe("fixture/hidden");
    },
  );

  it("keeps an approved explicit selection when the agent default is hidden", () => {
    const result = resolveChatModelSelectState({
      sessionKey: "main",
      modelRestricted: true,
      agentDefaultModel: "fixture/hidden",
      chatModelCatalog: catalog,
      modelOverrides: { main: "fixture/allowed" },
      sessionsResult: null,
    });
    expect(result.currentOverride).toBe("fixture/allowed");
    expect(result.defaultModel).toBe("");
  });

  it("preserves the selected runtime refusal on the primary catalog entry", () => {
    expect(
      resolveChatModelUnavailableReason("allowed", "fixture", [
        {
          ...catalog[0]!,
          available: false,
          unavailableReason: "unsupported-runtime",
        },
      ]),
    ).toBe("unsupported-runtime");
  });
});
