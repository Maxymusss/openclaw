/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { makeChatHost } from "./chat-host.test-support.ts";
import { ChatInputRecoveryPresentation } from "./chat-input-recovery-presentation.ts";
import {
  applyChatPendingInputs,
  getChatRecoveryInputs,
  getChatPendingInputs,
  loadChatPendingInputs,
  getChatThreadPendingInputs,
} from "./chat-pending-inputs.ts";
import { openSlot, type SidebarLayout } from "./sidebar-layout.ts";

function fixture() {
  const layout: SidebarLayout = { columns: [], open: false };
  const host = Object.assign(
    makeChatHost({
      sessionKey: "agent:main:recovery",
      currentSessionId: "physical-one",
      requestHandlers: {},
    }),
    { sidebarLayout: layout },
  );
  const input = {
    id: "old",
    state: "interrupted" as const,
    acceptedAt: 100,
    message: { role: "user", content: "old request", timestamp: 100 },
  };
  const gate = createDeferred();
  const presentation = new ChatInputRecoveryPresentation();
  let presented = true;
  const options = {
    isPresented: () => presented,
    prepare: vi.fn(() => gate.promise),
    open: vi.fn(() => {
      host.sidebarLayout = openSlot(host.sidebarLayout, "recovery");
    }),
    onError: vi.fn(),
  };
  const publish = (items = [input]) => applyChatPendingInputs(host, { items, total: items.length });
  return {
    host,
    input,
    gate,
    presentation,
    options,
    publish,
    hide: () => {
      presented = false;
    },
    show: () => {
      presented = true;
    },
  };
}

it("opens a complete panel once, never while checking or preparing, and respects dismissal", async () => {
  const f = fixture();
  f.presentation.sync(f.host, f.options);
  expect(f.options.prepare).not.toHaveBeenCalled();
  f.publish();
  f.presentation.sync(f.host, f.options);
  expect(f.options.open).not.toHaveBeenCalled();
  expect(f.host.sidebarLayout.open).toBe(false);
  f.gate.resolve();
  await f.gate.promise;
  await Promise.resolve();
  expect(f.options.open).toHaveBeenCalledTimes(1);
  f.host.sidebarLayout = { ...f.host.sidebarLayout, open: false };
  f.publish();
  f.presentation.sync(f.host, f.options);
  expect(f.options.open).toHaveBeenCalledTimes(1);
  f.publish([{ ...f.input, id: "new" }]);
  f.presentation.sync(f.host, f.options);
  expect(f.options.open).toHaveBeenCalledTimes(2);
});

it.each(["scope", "connection", "layout", "hidden", "consumed"])(
  "does not open after newer %s intent while chrome loads",
  async (change) => {
    const f = fixture();
    f.publish();
    f.presentation.sync(f.host, f.options);
    if (change === "scope") {
      f.host.currentSessionId = "physical-two";
    }
    if (change === "connection") {
      f.host.connectionEpoch += 1;
    }
    if (change === "layout") {
      f.host.sidebarLayout = openSlot(f.host.sidebarLayout, "workspace");
    }
    if (change === "hidden") {
      f.hide();
    }
    if (change === "consumed") {
      f.publish([]);
    }
    f.gate.resolve();
    await f.gate.promise;
    await Promise.resolve();
    expect(f.options.open).not.toHaveBeenCalled();
    if (change === "hidden") {
      f.show();
      f.presentation.sync(f.host, f.options);
      expect(f.options.open).toHaveBeenCalledTimes(1);
    }
  },
);

it("hides a restored recovery tab until current data and runtime are ready", () => {
  const f = fixture();
  f.host.sidebarLayout = openSlot(f.host.sidebarLayout, "recovery");
  const layout = f.presentation.layout(f.host, f.host.sidebarLayout);
  expect(layout.open).toBe(false);
  expect(layout.columns.flatMap((c) => c.panels).some((p) => p.slot === "recovery")).toBe(false);
  expect(f.host.sidebarLayout.open).toBe(true);
});

it("separates terminal requests from queued/resuming inputs without resurrecting canonical entries", () => {
  const f = fixture();
  const queued = { ...f.input, id: "queued", state: "queued" as const };
  const resuming = { ...f.input, id: "resuming", runId: "resume-run" };
  f.host.chatQueue = [
    {
      id: "local",
      text: "retry",
      createdAt: 50,
      sendRunId: "resume-run",
      sendState: "waiting-reconnect",
    },
  ];
  applyChatPendingInputs(f.host, { items: [f.input, queued, resuming], total: 3 });
  expect(getChatThreadPendingInputs(f.host).map((i) => i.id)).toEqual(["queued", "resuming"]);
  expect(getChatRecoveryInputs(f.host).map((i) => i.id)).toEqual(["old"]);
  const previous = getChatThreadPendingInputs(f.host);
  applyChatPendingInputs(f.host, { items: [{ ...f.input }, queued, resuming], total: 3 });
  expect(getChatThreadPendingInputs(f.host)).toBe(previous);
  f.host.chatMessages = [{ role: "user", content: "old request", __openclaw: { id: "old" } }];
  expect(getChatRecoveryInputs(f.host)).toEqual([]);
});

it("does not reveal a restored open tab if its last record disappears during preparation", async () => {
  const f = fixture();
  f.host.sidebarLayout = openSlot(f.host.sidebarLayout, "recovery");
  f.publish();
  f.presentation.sync(f.host, f.options);
  expect(f.presentation.layout(f.host, f.host.sidebarLayout).open).toBe(false);
  f.publish([]);
  f.gate.resolve();
  await f.gate.promise;
  await Promise.resolve();
  expect(f.options.open).not.toHaveBeenCalled();
  expect(f.presentation.layout(f.host, f.host.sidebarLayout).open).toBe(false);
});

it("reschedules fresh confirmed custody when a stale connection finishes preparing", async () => {
  const f = fixture();
  f.publish();
  f.presentation.sync(f.host, f.options);
  f.host.connectionEpoch += 1;
  f.publish();
  f.presentation.sync(f.host, f.options);
  const update = vi.fn();
  f.host.requestUpdate = update;
  f.gate.resolve();
  await f.gate.promise;
  await Promise.resolve();
  expect(update).toHaveBeenCalled();
  expect(f.options.open).not.toHaveBeenCalled();
  f.presentation.sync(f.host, f.options);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.options.open).toHaveBeenCalledOnce();
});

it("opens the confirmed latest page for new records but preserves an already-open historical page", async () => {
  const f = fixture();
  f.publish();
  f.presentation.sync(f.host, f.options);
  f.gate.resolve();
  await f.gate.promise;
  await Promise.resolve();
  const older = { ...f.input, id: "historical" };
  f.host.request.mockResolvedValue({
    sessionId: "physical-one",
    pendingInputs: { items: [older], total: 2 },
  });
  await loadChatPendingInputs(f.host, 2);
  const next = { ...f.input, id: "new-while-reading" };
  f.publish([f.input, next]);
  f.presentation.sync(f.host, f.options);
  expect(getChatPendingInputs(f.host)?.before).toBe(2);
  expect(getChatRecoveryInputs(f.host)).toEqual([older]);
  expect(f.options.open).toHaveBeenCalledTimes(1);
  f.host.sidebarLayout = { ...f.host.sidebarLayout, open: false };
  const newest = { ...f.input, id: "new-after-close" };
  f.publish([f.input, next, newest]);
  f.presentation.sync(f.host, f.options);
  expect(getChatPendingInputs(f.host)?.before).toBeUndefined();
  expect(getChatRecoveryInputs(f.host)).toEqual([f.input, next, newest]);
  expect(f.options.open).toHaveBeenCalledTimes(2);
  // The superseded background historical read cannot replace the selected latest page.
  await Promise.resolve();
  await Promise.resolve();
  expect(getChatRecoveryInputs(f.host)).toEqual([f.input, next, newest]);
});
