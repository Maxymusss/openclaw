/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChatPendingInputsPage } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { t } from "../../../i18n/index.ts";
import { formatDateTimeMs } from "../../../lib/format.ts";
import { makeChatPageHost } from "../chat-pending-inputs.test-support.ts";
import { applyChatPendingInputs } from "../chat-pending-inputs.ts";
import { createChatProps } from "../chat-view.test-helpers.ts";
import { renderChatInputRecovery } from "./chat-input-recovery.ts";

type PendingInput = ChatPendingInputsPage["items"][number];
const sessionKey = "agent:main:recovery-fixture";
const sessionId = "recovery-fixture-session";
const acceptedAt = Date.UTC(2026, 0, 14, 9, 30);

function input(id: string, state: PendingInput["state"] = "interrupted"): PendingInput {
  return {
    id,
    runId: `run-${id}`,
    acceptedAt,
    state,
    message: {
      role: "user",
      content: `Saved **${id}**`,
      timestamp: acceptedAt - 60_000,
      __openclaw: {
        id: `pending:${id}`,
        senderId: "fixture-author",
        senderName: "Fixture Author",
        transport: {
          clients: [{ id: "cli", mode: "cli", displayName: "Fixture CLI" }],
        },
      },
    },
  };
}

function fixture(requestHandlers: Record<string, unknown> = {}) {
  const host = makeChatPageHost({
    sessionKey,
    currentSessionId: sessionId,
    chatMessage: "Keep my composer draft",
    requestHandlers,
  });
  const chat = createChatProps({
    sessionKey,
    historyState: host,
    userName: "Viewer",
    draft: host.chatMessage,
    onSend: vi.fn(),
    onDraftChange: vi.fn(),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const paint = () => render(renderChatInputRecovery({ chat, host }), container);
  onTestFinished(() => {
    render(null, container);
    container.remove();
    chat.transcript.hostDisconnected();
  });
  return { host, chat, container, paint };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!match) {
    throw new Error(`Expected button: ${label}`);
  }
  return match;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recovery side-panel content", () => {
  it("renders saved terminal inputs with their author, accepted date, provenance, and copy-only action", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    const { host, chat, container, paint } = fixture();
    const interrupted = input("interrupted");
    const cancelled = input("cancelled", "cancelled");
    const queued = input("queued", "queued");
    applyChatPendingInputs(host, { items: [interrupted, cancelled, queued], total: 3 });
    const before = structuredClone([interrupted, cancelled, queued]);
    paint();

    expect(container.querySelectorAll(".chat-input-recovery__card")).toHaveLength(2);
    expect(container.querySelector(".chat-input-recovery__author")?.textContent).toContain(
      "Fixture Author",
    );
    expect(container.querySelector(".chat-input-recovery__source")?.textContent).toContain(
      "Fixture CLI",
    );
    expect(container.querySelector(".chat-input-recovery__accepted")?.textContent).toContain(
      formatDateTimeMs(acceptedAt, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }),
    );
    expect(container.querySelector(".chat-text strong")?.textContent).toBe("interrupted");
    expect(
      [...container.querySelectorAll(".chat-input-recovery__badge")].map((badge) =>
        badge.textContent?.trim(),
      ),
    ).toEqual([t("chat.inputRecovery.interruptedStatus"), t("chat.inputRecovery.cancelledStatus")]);
    expect(container.querySelector(".chat-input-recovery__description")?.textContent).toContain(
      t("chat.inputRecovery.recoveryDescription"),
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    button(container, t("common.copy")).click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Saved **interrupted**");
    expect(chat.onSend).not.toHaveBeenCalled();
    expect(chat.onDraftChange).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("Keep my composer draft");
    expect([interrupted, cancelled, queued]).toEqual(before);
    expect(container.querySelector("textarea, .chat-reply-btn, .chat-confirm-wrap")).toBeNull();
    expect(host.request).not.toHaveBeenCalled();
  });

  it("keeps cards and paging controls mounted while earlier and latest reads are pending", async () => {
    const earlier = createDeferred<unknown>();
    const latest = createDeferred<unknown>();
    const requests = [earlier, latest];
    const { host, container, paint } = fixture({
      "chat.history": () => requests.shift()?.promise,
    });
    const newest = input("newest");
    const oldest = input("oldest", "cancelled");
    applyChatPendingInputs(host, { items: [newest], total: 2, nextBefore: 2 });
    let commit = createDeferred();
    host.requestUpdate = () => {
      paint();
      commit.resolve();
    };
    paint();
    const card = container.querySelector(".chat-input-recovery__card");
    const earlierButton = button(container, t("chat.inputRecovery.earlier"));
    const latestButton = button(container, t("chat.inputRecovery.latest"));

    earlierButton.click();
    expect(container.querySelector(".chat-input-recovery__card")).toBe(card);
    expect(button(container, t("chat.inputRecovery.earlier"))).toBe(earlierButton);
    expect(earlierButton.disabled).toBe(true);
    expect(latestButton.disabled).toBe(true);
    expect(container.querySelector(".skeleton, .spinner, [role=progressbar]")).toBeNull();
    expect(container.textContent).not.toContain(t("common.loading"));
    expect(host.request).toHaveBeenLastCalledWith(
      "chat.history",
      expect.objectContaining({ pendingBefore: 2 }),
    );
    commit = createDeferred();
    earlier.resolve({ sessionId, pendingInputs: { items: [oldest], total: 2 } });
    await commit.promise;
    expect(container.textContent).toContain("oldest");
    expect(latestButton.disabled).toBe(false);
    const olderCard = container.querySelector(".chat-input-recovery__card");
    latestButton.click();
    expect(container.querySelector(".chat-input-recovery__card")).toBe(olderCard);
    expect(latestButton.disabled).toBe(true);
    commit = createDeferred();
    latest.resolve({ sessionId, pendingInputs: { items: [newest], total: 2, nextBefore: 2 } });
    await commit.promise;
    expect(container.textContent).toContain("newest");
    expect(earlierButton.disabled).toBe(false);
    expect(latestButton.disabled).toBe(true);
  });

  it("renders media-only inputs through the shared message body without inventing copy text", () => {
    const { host, container, paint } = fixture();
    const saved = input("image");
    saved.message = {
      role: "user",
      timestamp: acceptedAt,
      content: [
        {
          type: "image",
          url: "data:image/png;base64,iVBORw0KGgo=",
          alt: "Synthetic recovery image",
          width: 120,
          height: 80,
        },
      ],
      __openclaw: { id: "pending:image", senderName: "Fixture Author" },
    };
    applyChatPendingInputs(host, { items: [saved], total: 1 });
    paint();
    expect(container.querySelector(".chat-message-image")?.getAttribute("alt")).toBe(
      "Synthetic recovery image",
    );
    expect(container.querySelector(".chat-copy-btn")).toBeNull();
    expect(container.querySelector(".chat-input-recovery__author")?.textContent).toContain(
      "Fixture Author",
    );
  });

  it("retains the saved message and restores stable controls after a failed page read", async () => {
    const response = createDeferred<unknown>();
    const { host, container, paint } = fixture({ "chat.history": () => response.promise });
    applyChatPendingInputs(host, { items: [input("retained")], total: 2, nextBefore: 2 });
    let commit = createDeferred();
    host.requestUpdate = () => {
      paint();
      commit.resolve();
    };
    paint();
    const card = container.querySelector(".chat-input-recovery__card");
    const earlierButton = button(container, t("chat.inputRecovery.earlier"));
    earlierButton.click();
    commit = createDeferred();
    response.reject(new Error("Could not read earlier saved messages"));
    await commit.promise;
    expect(container.querySelector(".chat-input-recovery__card")).toBe(card);
    expect(earlierButton.disabled).toBe(false);
    expect(container.querySelector(".chat-input-recovery__error")?.textContent).toContain(
      "Could not read earlier saved messages",
    );
    expect(host.chatMessage).toBe("Keep my composer draft");
  });
});

it("preserves forwarded source-session context without creating an inert navigation link", () => {
  const { host, container, paint } = fixture();
  const saved = {
    ...input("forwarded"),
    message: {
      role: "assistant",
      content: "Continue the source task.",
      senderSession: {
        sessionKey: "agent:source:task",
        agentId: "source",
        label: "Backend cleanup",
      },
    },
  };
  applyChatPendingInputs(host, { items: [saved], total: 1 });
  paint();
  expect(container.querySelector(".chat-reply-attribution--forwarded")?.textContent).toContain(
    "Backend cleanup",
  );
  expect(container.querySelector(".chat-input-recovery__content")?.textContent).toContain(
    "Continue the source task.",
  );
  expect(container.querySelector("[data-session-key]")).toBeNull();
});
