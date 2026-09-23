// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeStoredQueueItem } from "../../lib/chat/outbox-store-codec.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { normalizeChatSendAck } from "./chat-send-ack.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();
const posted = { status: "posted", messageId: "posted-message", messageSeq: 2 };

describe("human discussion sends", () => {
  it.each([null, "active-work"])(
    "records without adopting or clearing agent work: %s",
    async (runId) => {
      const host = makeChatHost({
        currentSessionId: "session-one",
        chatRunId: runId,
        chatMessage: "@Morgan please check it",
        chatFollowUpMode: "interrupt",
        chatMentions: [{ profileId: "morgan", start: 0, end: 7 }],
        requestHandlers: { "chat.send": posted },
      });
      await handleSendChat(host, undefined, { participation: "humans" });
      expect(findChatSendPayload(host)).toMatchObject({
        participation: "humans",
        sessionId: "session-one",
        message: "@Morgan please check it",
      });
      expect(findChatSendPayload(host)).not.toHaveProperty("queueMode");
      expect(findChatSendPayload(host)).not.toHaveProperty("deliver");
      expect(host.chatRunId).toBe(runId);
      expect(host.chatSending).toBe(false);
      expect(host.chatQueue).toHaveLength(0);
      expect(host.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
    },
  );

  it("sends command-like discussion as text, not a stop", async () => {
    const host = makeChatHost({
      currentSessionId: "session-one",
      chatRunId: "active-work",
      chatMessage: "/stop",
      requestHandlers: { "chat.send": posted },
    });
    await handleSendChat(host, undefined, { participation: "humans" });
    expect(findChatSendPayload(host).message).toBe("/stop");
    expect(host.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
    expect(host.chatRunId).toBe("active-work");
  });

  it("defaults a human reply to discussion and permits an explicit agent override", async () => {
    const reply = {
      messageId: "human",
      sourceMessageId: "human",
      text: "Please review",
      participation: "humans" as const,
    };
    const human = makeChatHost({
      currentSessionId: "session-one",
      chatMessage: "Thanks",
      chatReplyTarget: reply,
      requestHandlers: { "chat.send": posted },
    });
    await handleSendChat(human);
    expect(findChatSendPayload(human).participation).toBe("humans");
    const agent = makeChatHost({
      currentSessionId: "session-one",
      chatMessage: "Agent, can you help Morgan?",
      chatReplyTarget: reply,
      requestHandlers: { "chat.send": { status: "started", runId: "agent-work" } },
    });
    await handleSendChat(agent, undefined, { participation: "agent" });
    expect(findChatSendPayload(agent).participation).toBe("agent");
    expect(agent.chatRunId).toBe("agent-work");
  });

  it("does not interpret a human mention as an exclusive audience", async () => {
    const host = makeChatHost({
      currentSessionId: "session-one",
      chatMessage: "@Morgan agent please review",
      chatMentions: [{ profileId: "morgan", start: 0, end: 7 }],
      requestHandlers: { "chat.send": { status: "started", runId: "agent-work" } },
    });
    await handleSendChat(host);
    expect(findChatSendPayload(host)).not.toHaveProperty("participation");
    expect(host.chatRunId).toBe("agent-work");
  });

  it("retains audience and session identity through durable restore", () => {
    expect(
      normalizeStoredQueueItem({
        id: "input",
        text: "Discussion",
        createdAt: 1,
        participation: "humans",
        sessionId: "original",
        sendRunId: "source",
        sendState: "sending",
      }),
    ).toMatchObject({
      participation: "humans",
      sessionId: "original",
      sendRunId: "source",
      sendState: "waiting-reconnect",
    });
    expect(
      normalizeStoredQueueItem({
        id: "input",
        text: "Discussion",
        createdAt: 1,
        participation: "invalid",
      }),
    ).toBeNull();
  });

  it("does not treat an incomplete posted receipt as success", () => {
    expect(() => normalizeChatSendAck({ status: "posted" }, "source")).toThrow("did not confirm");
  });
});
