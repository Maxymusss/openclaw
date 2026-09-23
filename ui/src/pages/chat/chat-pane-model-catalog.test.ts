/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, ModelCatalogResult } from "../../api/types.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  refreshChatModelCatalogOnDemand,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";

describe("chat pane composer controls", () => {
  it.each([false, true])(
    "uses the current catalog restriction with unchanged hello=%s",
    async (helloRestricted) => {
      const session: GatewaySessionRow = {
        key: "agent:main:policy",
        agentId: "main",
        kind: "direct",
        sessionId: "policy-session",
        modelProvider: "fixture",
        model: "hidden",
      };
      const hello = sessionMutationGatewayHello([
        "operator.sessions.read",
        "operator.sessions.write",
      ]);
      if (helloRestricted) {
        hello.auth!.modelRestricted = true;
      }
      let result: ModelCatalogResult = {
        models: [{ provider: "fixture", id: "allowed", name: "Allowed" }],
      };
      const request = vi.fn(async (method: string) =>
        method === "sessions.describe" ? { session } : result,
      );
      const client = createTestGatewayClient(request);
      const state = makeChatHost({
        client,
        hello,
        connectionEpoch: 1,
        sessionKey: session.key,
        sessionsResult: { ...createSessionsListResult(), sessions: [session] },
        requestUpdate: vi.fn(),
      }) as unknown as ChatPageHost;
      state.chatModelSwitchPromises = {};
      const container = document.createElement("div");
      try {
        for (const restricted of [false, true, false]) {
          result = {
            models: result.models,
            ...(restricted ? { modelRestricted: true as const } : {}),
          };
          invalidateChatMetadataStore(client, { agentId: "main", sessionKey: session.key });
          await refreshChatModelCatalogOnDemand(state);
          expect(state.chatModelRestricted).toBe(restricted);
          expect(state.client).toBe(client);
          expect(state.hello).toBe(hello);
          render(
            renderChatPaneComposerControls({
              state,
              selectedSession: session,
              agentDefaultModel: undefined,
              modelAccess: { allowed: true, requiredScope: "operator.write" },
              effortAccess: { allowed: true, requiredScope: "operator.write" },
              contextWindowAccess: readSessionMethodAccess(
                { phase: "connected", client, hello },
                { method: "sessions.patch", params: { key: session.key, contextWindow: null } },
              ),
              permissionAccess: { allowed: true, requiredScope: "operator.write" },
              canSelectFull: false,
              onModelSetup: vi.fn(),
            }).composerControls,
            container,
          );
          expect(
            container.querySelector(`[data-chat-model-option="fixture/hidden"]`) !== null,
          ).toBe(!restricted);
        }
      } finally {
        retireChatMetadataRequests(state);
        state.sessions.dispose();
        render(null, container);
      }
    },
  );
  it.each([
    {
      label: "warm",
      cachedModels: [{ id: "cached-model", name: "Cached Model", provider: "openai" }],
    },
    { label: "cold", cachedModels: [] },
  ])(
    "revalidates the $label configured model catalog when the picker opens",
    async ({ cachedModels }) => {
      const container = document.createElement("div");
      const catalog = createDeferred<{ models: typeof cachedModels }>();
      const session: GatewaySessionRow = {
        key: "main",
        agentId: "main",
        sessionId: "picker-session",
        kind: "direct",
        updatedAt: 1,
        contextTokens: 8192,
      };
      const request = vi.fn((method: string) =>
        method === "sessions.describe"
          ? Promise.resolve({ session: { ...session, contextTokens: 262144 } })
          : catalog.promise,
      );
      const state = makeChatHost({
        client: createTestGatewayClient(request),
        connectionEpoch: 1,
        chatModelCatalog: cachedModels,
        sessionKey: "main",
        sessionsResult: { ...createSessionsListResult(), sessions: [session] },
        requestUpdate: vi.fn(),
      }) as unknown as ChatPageHost;
      state.chatModelSwitchPromises = {};
      onTestFinished(() => {
        retireChatMetadataRequests(state);
        state.sessions.dispose();
      });
      const controlParams = {
        state,
        selectedSession: undefined,
        agentDefaultModel: undefined,
        modelAccess: { allowed: true, requiredScope: "operator.write" } as const,
        effortAccess: { allowed: true, requiredScope: "operator.write" } as const,
        contextWindowAccess: { allowed: true, requiredScope: "operator.admin" } as const,
        permissionAccess: { allowed: true, requiredScope: "operator.write" } as const,
        canSelectFull: true,
        onModelSetup: vi.fn(),
      };
      render(renderChatPaneComposerControls(controlParams).composerControls, container);

      const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
      picker!.open = true;
      picker!.dispatchEvent(new Event("toggle"));

      expect(state.chatModelPickerOpenSessionKey).toBe("main");
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith("models.list", {
        view: "configured",
        agentId: "main",
        sessionKey: "main",
      });
      expect(state.chatModelsLoading).toBe(cachedModels.length === 0);
      render(renderChatPaneComposerControls(controlParams).composerControls, container);
      if (cachedModels.length > 0) {
        expect(container.querySelector("[data-chat-model-catalog-state]")).toBeNull();
        expect(
          container.querySelector<HTMLButtonElement>("[data-chat-model-option]")?.disabled,
        ).toBe(false);
        expect(container.textContent).toContain("Cached Model");
      } else {
        expect(container.querySelector('[data-chat-model-catalog-state="loading"]')).not.toBeNull();
        expect(container.textContent).toContain("Loading models…");
      }
      const freshModels = [{ id: "fresh-model", name: "Fresh Model", provider: "openai" }];
      catalog.resolve({ models: freshModels });
      await vi.waitFor(() => expect(state.chatModelCatalog).toEqual(freshModels));
      await vi.waitFor(() => expect(state.sessionsResult?.sessions[0]?.contextTokens).toBe(262144));
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "models.list",
        "sessions.describe",
      ]);
    },
  );
});
