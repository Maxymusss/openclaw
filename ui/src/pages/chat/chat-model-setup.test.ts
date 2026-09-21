import { describe, expect, it } from "vitest";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { requiresChatModelSetup, resolveChatModelSetup } from "./chat-model-setup.ts";

describe("requiresChatModelSetup", () => {
  it.each(["allowed", "unavailable", "absent"] as const)(
    "resolves the actual %s selection against a restricted catalog with a redacted default",
    (mode) => {
      const hello = sessionMutationGatewayHello(["operator.sessions.write"]);
      hello.auth!.modelRestricted = true;
      const session = {
        key: "agent:main:existing",
        kind: "direct" as const,
        model: "approved",
        modelProvider: "fixture",
      };
      const state = makeChatHost({
        hello,
        sessionKey: session.key,
        sessionsResult: {
          ...createSessionsListResult({ defaultsModel: null }),
          sessions: [session],
        },
        chatModelCatalog:
          mode === "absent"
            ? []
            : [
                {
                  provider: "fixture",
                  id: "approved",
                  available: mode === "allowed",
                  ...(mode === "unavailable"
                    ? { unavailableReason: "unsupported-runtime" as const }
                    : {}),
                },
              ],
      });
      const setup = resolveChatModelSetup({
        state,
        session,
        agent: { id: "main" },
        agentsLoaded: true,
        catalog: false,
        onSetup: () => {},
      });
      expect(setup.modelSetupRequired).toBe(mode !== "allowed");
      expect(setup.modelUnavailableBanner !== undefined).toBe(mode === "unavailable");
      state.sessions.dispose();
    },
  );

  it.each([true, false])(
    "uses the approved explicit selection when the default is redacted: %s",
    (selectedModelAvailable) => {
      expect(
        requiresChatModelSetup({
          catalog: false,
          connected: true,
          agentsLoaded: true,
          selectedAgentFound: true,
          selectedModelAvailable,
        }),
      ).toBe(!selectedModelAvailable);
    },
  );
  it("requires setup after the selected agent loads without a model route", () => {
    expect(
      requiresChatModelSetup({
        catalog: false,
        connected: true,
        agentsLoaded: true,
        selectedAgentFound: true,
      }),
    ).toBe(true);
  });

  it("accepts a configured agent model", () => {
    expect(
      requiresChatModelSetup({
        catalog: false,
        connected: true,
        agentsLoaded: true,
        selectedAgentFound: true,
        agentModel: "openai/gpt-5.4",
      }),
    ).toBe(false);
  });

  it("does not block while connection or agent data is unresolved", () => {
    expect(
      requiresChatModelSetup({
        catalog: false,
        connected: true,
        agentsLoaded: false,
        selectedAgentFound: false,
      }),
    ).toBe(false);
  });
});
