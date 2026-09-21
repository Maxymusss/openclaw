/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { resolveChatModelSetup } from "./chat-model-setup.ts";
import {
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

describe("chat pane model-setting permissions", () => {
  it("selects, commits and sends an approved model on an existing thread with a redacted default", async () => {
    const initial: GatewaySessionRow = {
      key: "agent:main:restricted",
      kind: "direct",
      sessionId: "existing-generation",
    };
    let row = initial;
    const result = () => ({
      ...createSessionsListResult({ defaultsModel: null }),
      sessions: [row],
    });
    const hello = sessionMutationGatewayHello([
      "operator.sessions.read",
      "operator.sessions.write",
    ]);
    hello.auth!.modelRestricted = true;
    const host = makeChatHost({
      sessionKey: row.key,
      sessionsResult: result(),
      hello,
      chatModelCatalog: [
        { id: "approved", name: "Approved model", provider: "fixture", available: true },
      ],
      chatModelSwitchPromises: {},
      requestHandlers: {
        "sessions.patch": () => {
          row = { ...row, model: "approved", modelProvider: "fixture" };
          return {
            ok: true,
            key: row.key,
            entry: {
              sessionId: row.sessionId,
              modelOverride: "approved",
              providerOverride: "fixture",
            },
            resolved: { model: "approved", modelProvider: "fixture" },
          };
        },
        "sessions.list": result,
        "chat.send": { status: "started", runId: "approved-model-run" },
      },
    });
    const state = host as unknown as ChatPageHost;
    state.chatModelPickerOpenSessionKey = row.key;
    const selectedSession = () =>
      state.sessions.state.result?.sessions.find((session) => session.key === initial.key) ??
      initial;
    const setup = () =>
      resolveChatModelSetup({
        state,
        session: selectedSession(),
        agent: { id: "main" },
        agentsLoaded: true,
        catalog: false,
        onSetup: vi.fn(),
      });
    const container = document.createElement("div");
    const draw = () => {
      const access = readChatPaneMutationAccess(
        { client: state.client, phase: "connected", hello } as ApplicationGatewaySnapshot,
        row.key,
      );
      const controls = renderChatPaneComposerControls({
        state,
        selectedSession: selectedSession(),
        agentDefaultModel: undefined,
        modelAccess: access.model,
        effortAccess: access.effort,
        contextWindowAccess: access.contextWindow,
        permissionAccess: access.permission,
        canSelectFull: false,
        onModelSetup: vi.fn(),
      });
      render(controls.composerControls, container);
    };
    try {
      expect(setup().modelSetupRequired).toBe(true);
      draw();
      const choice = container.querySelector<HTMLButtonElement>(
        '[data-chat-model-option="fixture/approved"]',
      );
      expect(choice).not.toBeNull();
      choice!.click();
      const patch = state.chatModelSwitchPromises[row.key];
      expect(patch).toBeDefined();
      expect(await patch).toBe(true);
      expect(host.request).toHaveBeenCalledWith(
        "sessions.patch",
        expect.objectContaining({
          key: row.key,
          model: "fixture/approved",
          expectedSessionId: row.sessionId,
        }),
      );
      expect(Object.hasOwn(state.sessions.state.modelOverrides, initial.key)).toBe(false);
      expect(state.sessions.state.result?.sessions).toEqual([
        expect.objectContaining({
          key: initial.key,
          sessionId: initial.sessionId,
          model: "approved",
          modelProvider: "fixture",
        }),
      ]);
      state.sessionsResult = state.sessions.state.result;
      expect(setup().modelSetupRequired).toBe(false);
      expect(setup().modelUnavailableBanner).toBeUndefined();
      draw();
      expect(
        container.querySelector<HTMLElement>("[data-chat-model-select]")?.dataset.chatSelectValue,
      ).toBe("fixture/approved");
      await handleSendChat(host, "Use this approved model");
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([
        [
          "chat.send",
          expect.objectContaining({ sessionKey: row.key, message: "Use this approved model" }),
        ],
      ]);
      expect(host.lastError).toBeNull();
    } finally {
      render(null, container);
      host.sessions.dispose();
    }
  });

  it.each(["operator.read", "operator.write", "operator.admin"])(
    "uses exact field permissions for an existing session with %s",
    async (scope) => {
      const selectedSession: GatewaySessionRow = {
        key: "agent:main:existing",
        kind: "direct",
        sessionId: "existing-session",
        model: "gpt-test-a",
        modelProvider: "openai",
        thinkingLevel: "low",
        fastMode: false,
        thinkingLevels: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
        contextWindow: "standard",
        contextWindowDefault: "standard",
        contextWindows: [
          { id: "standard", label: "Standard", contextWindow: 100000 },
          { id: "extended", label: "Extended", contextWindow: 200000 },
        ],
      };
      const sessionsResult = { ...createSessionsListResult(), sessions: [selectedSession] };
      const state = makeChatHost({
        sessionKey: selectedSession.key,
        sessionsResult,
        hello: sessionMutationGatewayHello([scope]),
        chatModelCatalog: [
          { id: "gpt-test-a", name: "Test model", provider: "openai", supportsFastMode: true },
        ],
        chatModelSwitchPromises: {},
        requestHandlers: {
          "sessions.patch": { ok: true, key: selectedSession.key, entry: selectedSession },
          "sessions.list": sessionsResult,
        },
      });
      const access = readChatPaneMutationAccess(
        {
          client: state.client,
          phase: "connected",
          hello: state.hello,
        } as ApplicationGatewaySnapshot,
        selectedSession.key,
      );
      const controls = renderChatPaneComposerControls({
        state: state as unknown as ChatPageHost,
        selectedSession,
        agentDefaultModel: undefined,
        modelAccess: access.model,
        effortAccess: access.effort,
        contextWindowAccess: access.contextWindow,
        permissionAccess: access.permission,
        canSelectFull: scope === "operator.admin",
        onModelSetup: vi.fn(),
      });
      const container = document.createElement("div");
      render(controls.composerControls, container);
      const readOnly = scope === "operator.read";
      expect(
        container.querySelector("[data-chat-model-select]")?.getAttribute("aria-disabled"),
      ).toBe(String(readOnly));
      expect(
        container.querySelector("[data-chat-thinking-select]")?.getAttribute("aria-disabled"),
      ).toBe(String(readOnly));
      const thinking = container.querySelector<HTMLInputElement>("[data-chat-thinking-slider]")!;
      const fast = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]")!;
      const context = container.querySelector<HTMLButtonElement>(
        "[data-chat-context-window-toggle]",
      )!;
      expect(thinking.disabled).toBe(readOnly);
      expect(fast.disabled).toBe(readOnly);
      expect(context.disabled).toBe(scope !== "operator.admin");
      context.click();
      if (!readOnly) {
        thinking.value = "1";
        thinking.dispatchEvent(new Event("change", { bubbles: true }));
        fast.click();
        await vi.waitFor(() =>
          expect(state.request).toHaveBeenCalledWith(
            "sessions.patch",
            expect.objectContaining({ key: selectedSession.key, fastMode: true }),
          ),
        );
        expect(state.request).toHaveBeenCalledWith(
          "sessions.patch",
          expect.objectContaining({ key: selectedSession.key, thinkingLevel: "high" }),
        );
      } else {
        fast.click();
        expect(state.request).not.toHaveBeenCalled();
      }
      const contextPatches = state.request.mock.calls.filter(
        ([method, params]) =>
          method === "sessions.patch" &&
          params &&
          typeof params === "object" &&
          "contextWindow" in params,
      );
      expect(contextPatches).toHaveLength(scope === "operator.admin" ? 1 : 0);
    },
  );
});
