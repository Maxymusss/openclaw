/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { input, sessionId, sessionKey } from "./chat-pending-inputs.test-support.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import { resetTranscriptSession } from "./components/chat-thread-interactions.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { selectChatInputDisplay } from "./history-merge.ts";

beforeEach(() => installTranscriptDomMocks());

afterEach(() => {
  resetChatViewState();
  resetTranscriptSession("single");
  resetTranscriptTestDom();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderChatView(overrides: Partial<Parameters<typeof renderChat>[0]> = {}) {
  const container = document.createElement("div");
  render(renderChat(createChatProps(overrides)), container);
  return container;
}

it("keeps editable Control UI input beside the composer and out of history", () => {
  const local: ChatQueueItem = {
    id: "local-row",
    sendRunId: "run-queued",
    sessionKey,
    sessionId,
    text: "Keep my queued input",
    createdAt: 50,
    sendState: "waiting-idle",
  };

  const display = selectChatInputDisplay([], [local], []);

  expect(display.queue).toEqual([local]);
  expect(display.queue[0]).toBe(local);
  expect(display.threadQueue).toEqual([]);
  expect(display.pendingInputs).toEqual([]);
  expect(
    buildChatItems({
      paneId: "pane",
      sessionKey,
      messages: [],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      queue: [local],
      pendingInputs: [],
      showToolCalls: true,
    }).some((item) => item.kind === "group" && item.role === "user"),
  ).toBe(false);
});

it("lets Gateway acceptance replace a stale editable browser copy", () => {
  const local: ChatQueueItem = {
    id: "local-row",
    sendRunId: "run-queued",
    text: "Browser copy",
    createdAt: 50,
    sendState: "waiting-idle",
  };
  const queued = { ...input, state: "queued" as const };

  const display = selectChatInputDisplay([], [local], [queued]);

  expect(display.queue).toEqual([]);
  expect(display.threadQueue).toEqual([]);
  expect(display.pendingInputs).toEqual([queued]);
});

it("keeps pending input from another client in the transcript", () => {
  const queued = { ...input, state: "queued" as const };

  const display = selectChatInputDisplay([], [], [queued]);

  expect(display.queue).toEqual([]);
  expect(display.threadQueue).toEqual([]);
  expect(display.pendingInputs).toEqual([queued]);
  expect(
    buildChatItems({
      paneId: "pane",
      sessionKey,
      messages: [],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      pendingInputs: [queued],
      showToolCalls: true,
    }).some((item) => item.kind === "group" && item.role === "user"),
  ).toBe(true);
});

it("retires the Control UI row only when canonical history adopts it", () => {
  const local: ChatQueueItem = {
    id: "local-row",
    sendRunId: "run-queued",
    text: "Keep my accepted input",
    createdAt: 50,
  };
  const canonical = {
    role: "user",
    content: "Keep my accepted input",
    __openclaw: { id: input.id, idempotencyKey: "run-queued:user" },
  };

  const display = selectChatInputDisplay([canonical], [local], []);

  expect(display.queue).toEqual([]);
  expect(display.threadQueue).toEqual([]);
  expect(display.pendingInputs).toEqual([]);
});

it("keeps a timestamped zero-attempt failure visible with recovery actions", () => {
  const onQueueRetry = vi.fn();
  const onQueueRemove = vi.fn();
  const container = renderChatView({
    queue: [
      {
        id: "preflight-failure",
        text: "Keep the failed attachment send visible",
        createdAt: 10,
        sendAttempts: 0,
        sendSubmittedAtMs: 10,
        sendState: "failed",
        sendError: "Attachment hydration failed",
      },
    ],
    onQueueRetry,
    onQueueRemove,
  });

  expect(container.querySelector(".chat-queue__item")).toBeNull();
  expect(container.querySelector(".chat-thread")?.textContent).toContain(
    "Keep the failed attachment send visible",
  );
  const status = container.querySelector<HTMLElement>(".chat-send-status");
  expect(status?.dataset.sendState).toBe("failed");
  status?.querySelector<HTMLButtonElement>(".chat-send-status__retry")?.click();
  status?.querySelector<HTMLButtonElement>(".chat-send-status__discard")?.click();
  expect(onQueueRetry).toHaveBeenCalledWith("preflight-failure");
  expect(onQueueRemove).toHaveBeenCalledWith("preflight-failure");
});
