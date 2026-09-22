/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsPatchResult } from "../../api/types.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  normalizeStoredQueueItem,
  sameQueuedDeliveryVersion,
} from "../../lib/chat/outbox-store-codec.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { admitQueuedMessageForSession } from "./chat-queue.ts";
import { resumeStoredChatOutboxes, retryQueuedChatMessage } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { getPendingChatPickerPatch, patchChatSessionSettings } from "./chat-settings-patches.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import * as payloads from "./outbox-payloads.ts";

useChatSendBrowserFixture();

const sessionKey = "agent:main:foreground";
const sessionId = "foreground-session";
function foregroundHello() {
  const hello = sessionMutationGatewayHello();
  hello.auth.executionPolicy = "foreground-only";
  return hello;
}

function holdInputHandoff() {
  let releaseInput: (() => void) | undefined;
  vi.stubGlobal(
    "MessageChannel",
    class {
      port1 = {
        addEventListener: (_type: string, callback: () => void) => {
          releaseInput = callback;
        },
        start: () => undefined,
        close: () => undefined,
      };
      port2 = { postMessage: () => undefined, close: () => undefined };
    },
  );
  return {
    entered: () => vi.waitFor(() => expect(releaseInput).toBeTypeOf("function")),
    release: () => releaseInput?.(),
  };
}

describe("foreground-only chat admission", () => {
  it.each(["busy", "offline"] as const)(
    "preserves the draft without queueing while %s",
    async (state) => {
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        hello: foregroundHello(),
        chatMessage: "A fresh request",
        connected: state !== "offline",
        chatRunId: state === "busy" ? "existing-turn" : null,
        requestHandlers: {},
      });
      await handleSendChat(host);
      expect(host.chatMessage).toBe("A fresh request");
      expect(host.chatQueue).toEqual([]);
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(host.request).not.toHaveBeenCalled();
      expect(host.chatError).toContain("not been queued");
    },
  );

  it("rechecks busy state after the settings barrier before durable admission", async () => {
    const settings = createDeferred<boolean>();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      hello: foregroundHello(),
      chatMessage: "Keep this draft",
      pendingSettingsPatches: { [sessionKey]: settings.promise },
      requestHandlers: {},
    });
    const sending = handleSendChat(host);
    await Promise.resolve();
    host.chatRunId = "another-turn";
    settings.resolve(true);
    await sending;
    expect(host.chatMessage).toBe("Keep this draft");
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
  });

  it.each([false, true])(
    "allows a new explicit idle send (foreground restriction: %s)",
    async (restricted) => {
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        hello: restricted ? foregroundHello() : sessionMutationGatewayHello(),
        chatMessage: "A new request",
        requestHandlers: {
          "chat.send": { status: "started", messageSeq: 1 },
        },
      });
      await handleSendChat(host, undefined, undefined, new Event("submit"));
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
      expect(host.chatMessage).toBe("");
    },
  );

  it.each([false, true])(
    "does not let an old restricted receipt strand a new request after promotion: %s",
    async (promoted) => {
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        hello: promoted ? sessionMutationGatewayHello() : foregroundHello(),
        chatMessage: "New explicit request",
        requestHandlers: {
          "chat.send": { status: "started", messageSeq: 1 },
          "chat.history": {
            sessionId,
            messages: [],
            inputReceipts: [],
            pendingInputs: { items: [], total: 0 },
            sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
          },
        },
      });
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
          id: "retained-input",
          text: "Uncertain old request",
          createdAt: 1,
          sessionKey,
          sessionId,
          sendRunId: "old-request",
          sendAttempts: 1,
          sendState: "unconfirmed",
          foregroundOnly: true,
        }),
      ).toBe(true);
      await handleSendChat(host, undefined, undefined, new Event("submit"));
      const calls = host.request.mock.calls.filter(([method]) => method === "chat.send");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toMatchObject({ message: "New explicit request" });
      expect(calls[0]?.[1]).not.toMatchObject({ idempotencyKey: "old-request" });
      expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
        id: "retained-input",
        foregroundOnly: true,
      });
    },
  );

  it("keeps the first live input handoff ahead of a second guest submission", async () => {
    const input = holdInputHandoff();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      hello: foregroundHello(),
      chatMessage: "First owned input",
      requestHandlers: { "chat.send": { status: "started", messageSeq: 1 } },
    });
    const first = handleSendChat(host, undefined, undefined, new Event("submit"));
    await input.entered();
    try {
      expect(listStoredChatOutboxes(host)[0]?.queue).toHaveLength(1);
      host.chatMessage = "Second input stays a draft";
      await handleSendChat(host, undefined, undefined, new Event("submit"));
      expect(host.chatMessage).toBe("Second input stays a draft");
      expect(host.chatError).toContain("not been queued");
      expect(listStoredChatOutboxes(host)[0]?.queue).toHaveLength(1);
      await resumeStoredChatOutboxes(host);
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
    } finally {
      input.release();
      await first;
    }
    const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.[1]).toMatchObject({ message: "First owned input" });
    expect(host.chatMessage).toBe("Second input stays a draft");
  });

  it("keeps a newly pending picker tail ahead of another guest submission", async () => {
    const input = holdInputHandoff();
    const settings = createDeferred<SessionsPatchResult>();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      hello: foregroundHello(),
      chatMessage: "First input",
      requestHandlers: {
        "chat.send": { status: "started", messageSeq: 1 },
        "sessions.patch": () => settings.promise,
      },
    });
    const first = handleSendChat(host, undefined, undefined, new Event("submit"));
    await input.entered();
    const picker = patchChatSessionSettings(
      host,
      sessionKey,
      { model: "test/next-model" },
      { expectedSessionId: sessionId },
    );
    try {
      expect(getPendingChatPickerPatch(host, sessionKey)).toBeDefined();
      await vi.waitFor(() =>
        expect(host.request).toHaveBeenCalledWith(
          "sessions.patch",
          expect.objectContaining({ key: sessionKey, expectedSessionId: sessionId }),
        ),
      );
      input.release();
      await vi.waitFor(() => expect(host.chatQueue[0]?.sendState).toBe("waiting-model"));
      // Reload-safe storage is failed, but the real picker still owns the row.
      const outbox = listStoredChatOutboxes(host)[0];
      const stored = outbox?.queue[0];
      expect(stored?.sendState).toBe("failed");
      if (!outbox || !stored) {
        throw new Error("Expected the admitted picker-owned row");
      }
      expect(chatOutboxOwner(host).hasPendingSubmission(outbox, stored)).toBe(false);
      expect(chatOutboxOwner(host).needsReview(outbox, stored)).toBe(false);
      host.chatMessage = "Keep the second draft";
      await handleSendChat(host, undefined, undefined, new Event("submit"));
      expect(host.chatMessage).toBe("Keep the second draft");
      expect(host.chatError).toContain("not been queued");
      expect(listStoredChatOutboxes(host)[0]?.queue).toHaveLength(1);
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
    } finally {
      input.release();
      settings.resolve({ ok: true, path: "", key: sessionKey, entry: { sessionId } });
      await Promise.all([picker, first]);
    }
    expect(host.chatMessage).toBe("Keep the second draft");
  });

  it("keeps the draft after its connection changes while attachment storage is pending", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const prepare = payloads.prepareOutboxPayload;
    vi.spyOn(payloads, "prepareOutboxPayload").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return await prepare(...args);
    });
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      hello: foregroundHello(),
      chatMessage: "Keep attached draft",
      chatAttachments: [
        { id: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,aQ==" },
      ],
      requestHandlers: {},
    });
    const sending = handleSendChat(host);
    await entered.promise;
    host.connectionEpoch += 1;
    host.hello = sessionMutationGatewayHello();
    release.resolve();
    await sending;
    expect(host.chatMessage).toBe("Keep attached draft");
    expect(host.chatAttachments).toHaveLength(1);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
  });

  it("keeps the original restriction after promotion and still observes consumed receipts", async () => {
    let consumed = false;
    const row: ChatQueueItem = {
      id: "restricted-input",
      text: "Original request",
      createdAt: 1,
      sessionKey,
      sessionId,
      sendRunId: "accepted-turn",
      sendAttempts: 1,
      sendState: "waiting-reconnect",
      foregroundOnly: true,
    };
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      hello: sessionMutationGatewayHello(),
      requestHandlers: {
        "chat.history": () => ({
          sessionId,
          messages: [],
          pendingInputs: consumed
            ? { items: [], total: 0 }
            : {
                total: 1,
                items: [
                  {
                    id: "accepted-input",
                    runId: row.sendRunId,
                    acceptedAt: 1,
                    state: "interrupted",
                    message: { role: "user", content: row.text },
                  },
                ],
              },
          inputReceipts: consumed
            ? [{ runId: row.sendRunId, state: "consumed", consumedByEventId: "user-entry" }]
            : [{ runId: row.sendRunId, state: "pending" }],
          sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
        }),
      },
    });
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), row),
    ).toBe(true);
    await resumeStoredChatOutboxes(host);
    await retryQueuedChatMessage(host, row.id);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
      foregroundOnly: true,
      sendRunId: row.sendRunId,
    });
    consumed = true;
    await resumeStoredChatOutboxes(host);
    expect(listStoredChatOutboxes(host)).toEqual([]);
  });

  it("parks never-attempted stored input instead of auto-sending when a guest reconnects", async () => {
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      hello: foregroundHello(),
      requestHandlers: {
        "chat.history": {
          sessionId,
          messages: [],
          pendingInputs: { items: [], total: 0 },
          inputReceipts: [],
          sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
        },
      },
    });
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
        id: "saved-draft",
        text: "Saved before reconnect",
        createdAt: 1,
        sessionKey,
        sessionId,
        sendRunId: "never-attempted",
        sendAttempts: 0,
        sendState: "waiting-idle",
      }),
    ).toBe(true);
    await resumeStoredChatOutboxes(host);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
      foregroundOnly: true,
      sendState: "unconfirmed",
    });
  });

  it("retains malformed negative intent and compares it as delivery identity", () => {
    const ordinary = { id: "input", text: "draft", createdAt: 1 };
    for (const foregroundOnly of [true, false, null, "unknown"]) {
      const restored = normalizeStoredQueueItem({ ...ordinary, foregroundOnly });
      expect(restored?.foregroundOnly).toBe(true);
      expect(sameQueuedDeliveryVersion(ordinary, restored!)).toBe(false);
    }
  });
});
