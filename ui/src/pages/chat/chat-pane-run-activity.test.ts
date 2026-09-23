/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { renderChat } from "./chat-view.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { resetChatComposerState } from "./components/chat-composer.ts";

function sessionsResult(rows: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: rows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: rows,
  };
}

afterEach(() => {
  resetChatComposerState();
  vi.restoreAllMocks();
});

describe.each([false, true])("chat run activity (recovery ready: %s)", (recoveryScopeReady) => {
  it.each([
    {
      name: "keeps a completed parent idle while its visible child runs",
      selectedKey: "agent:main:main",
      parentActive: false,
      expectWorking: false,
    },
    {
      name: "shows activity on the visible child itself",
      selectedKey: "agent:main:subagent:attachment-fix",
      parentActive: false,
      expectWorking: true,
    },
    {
      name: "shows activity while the parent has its own live turn",
      selectedKey: "agent:main:main",
      parentActive: true,
      expectWorking: true,
    },
  ])("$name", ({ selectedKey, parentActive, expectWorking }) => {
    const parentKey = "agent:main:main";
    const childKey = "agent:main:subagent:attachment-fix";
    const parent = {
      key: parentKey,
      kind: "direct",
      updatedAt: 2,
      status: parentActive ? "running" : "done",
      hasActiveRun: parentActive,
      activeRunIds: parentActive ? ["parent-run"] : [],
      hasActiveSubagentRun: true,
      childSessions: [childKey],
    } satisfies GatewaySessionRow;
    const child = {
      key: childKey,
      kind: "direct",
      updatedAt: 3,
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["child-run"],
      subagentRunState: "active",
      spawnedBy: parentKey,
      parentSessionKey: parentKey,
      startedAt: 1,
    } satisfies GatewaySessionRow;
    const client = {
      request: async () => ({}),
      recoveryScopeReady,
    } as unknown as GatewayBrowserClient;
    const { pane, state, context } = createRefreshChatPane(client);
    context.gateway.snapshot.hello = sessionMutationGatewayHello(["operator.write"]);
    state.sessionKey = selectedKey;
    state.sessionsResult = sessionsResult([parent, child]);
    pane.render();

    const container = document.createElement("div");
    render(renderChat(pane.chatProps!), container);

    expect(pane.chatProps?.canAbort).toBe(true);
    expect(container.querySelector(".chat-reading-indicator") !== null).toBe(expectWorking);
  });
});

describe("foreground pane draft editing", () => {
  async function renderForegroundPane() {
    const request = createGatewayRequestMock(async () => ({ aborted: true }));
    const { pane, state, context } = createRefreshChatPane(createTestGatewayClient(request));
    const hello = sessionMutationGatewayHello(["operator.sessions.write"]);
    hello.auth.executionPolicy = "foreground-only";
    context.gateway.snapshot.hello = state.hello = hello;
    state.sessionKey = "agent:main:foreground-draft";
    state.chatRunId = "foreground-run";
    state.chatRunStatus = null;
    state.chatLoading = false;
    state.settings = { ...state.settings, chatSendShortcut: "enter" };
    const row: GatewaySessionRow = {
      key: state.sessionKey,
      sessionId: "foreground-session",
      kind: "direct",
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: [state.chatRunId],
      visibility: "shared",
      sharingRole: "owner",
    };
    state.currentSessionId = row.sessionId ?? null;
    state.sessionsResult = sessionsResult([row]);
    const container = document.body.appendChild(document.createElement("div"));
    const repaint = () => {
      pane.render();
      if (!pane.chatProps) {
        throw new Error("Missing pane-owned chat props");
      }
      render(renderChat(pane.chatProps), container);
      return pane.chatProps;
    };
    repaint();
    await vi.dynamicImportSettled();
    onTestFinished(() => {
      render(nothing, container);
      container.remove();
    });
    const textarea = container.querySelector("textarea");
    if (!textarea) {
      throw new Error("Missing pane composer textarea");
    }
    return { pane, state, request, row, container, textarea, repaint };
  }

  it("retains typing and Stop while submission is held, then enables the same draft when idle", async () => {
    const { pane, state, request, row, container, textarea, repaint } =
      await renderForegroundPane();
    const send = vi.spyOn(state, "handleSendChat");
    const abort = vi.spyOn(state, "handleAbortChat");
    const requestsBefore = request.mock.calls.length;
    expect(pane.chatProps?.canSend).toBe(false);
    expect(textarea.disabled).toBe(false);
    container.querySelector<HTMLElement>(".agent-chat__input")?.click();
    expect(document.activeElement).toBe(textarea);
    textarea.value = "Keep this next request";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "t" }));
    repaint();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    textarea.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(textarea.value).toBe("Keep this next request");
    expect(state.chatMessage).toBe(textarea.value);
    expect(state.chatQueue).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(requestsBefore);
    for (const layout of ["desktop", "mobile"]) {
      const stop = container.querySelector<HTMLButtonElement>(
        `.chat-${layout}-primary-action .chat-send-btn--stop`,
      );
      expect(stop?.disabled).toBe(false);
    }
    container.querySelector<HTMLButtonElement>(".chat-send-btn--stop")?.click();
    expect(abort).toHaveBeenCalledExactlyOnceWith({ preserveDraft: true });
    await abort.mock.results[0]?.value;
    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: state.sessionKey,
      runId: "foreground-run",
    });
    expect(state.chatMessage).toBe("Keep this next request");

    state.chatRunId = null;
    state.chatRunStatus = {
      phase: "done",
      runId: "foreground-run",
      sessionKey: state.sessionKey,
      occurredAt: 1,
    };
    row.hasActiveRun = false;
    row.activeRunIds = [];
    expect(repaint().canSend).toBe(true);
    expect(textarea.value).toBe("Keep this next request");
    expect(container.querySelector<HTMLButtonElement>(".chat-send-btn--send")?.disabled).toBe(
      false,
    );
    expect(container.querySelector(".chat-send-btn--stop")).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(state.chatQueue).toEqual([]);
  });

  it.each(["/goal start ", "/", "@person"])(
    "keeps held text %j out of command, goal and mention activation",
    async (draft) => {
      const { pane, state, request, container, textarea, repaint } = await renderForegroundPane();
      const requestsBefore = request.mock.calls.length;
      textarea.value = draft;
      textarea.setSelectionRange(draft.length, draft.length);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: draft }));
      textarea.dispatchEvent(new Event("select", { bubbles: true }));
      repaint();
      await vi.dynamicImportSettled();
      const composer = getChatComposerState(pane.presentationId);
      expect(state.chatMessage).toBe(draft);
      expect(composer.goalComposer).toBeNull();
      expect(composer.slashMenuOpen).toBe(false);
      expect(composer.skillMenuOpen).toBe(false);
      expect(composer.mentionMenu.open).toBe(false);
      expect(container.querySelector('[role="listbox"]')).toBeNull();
      expect(request).toHaveBeenCalledTimes(requestsBefore);
      expect(state.chatQueue).toEqual([]);
    },
  );
});
