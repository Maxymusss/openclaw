import type { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { historyPages } from "../../config/sessions/session-transcript-worker-resources.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import * as stores from "../session-utils-store.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { admitChatSend } from "./chat-send-admission.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession } from "./chat-send-session.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();
afterEach(() => vi.restoreAllMocks());

it.each(["current", "caller-revoked", "source-closed"] as const)(
  "retains live admission authority through the asynchronous read (%s)",
  async (scenario) => {
    const revoke = scenario !== "current";
    const fixture = await createFixture();
    const request = normalizeChatSendRequest({ params: fixture.params, client: fixture.client });
    if (!request.ok) throw new Error(request.error);
    const session = await prepareChatSendSession({
      request: request.value,
      client: fixture.client,
      context: fixture.context,
    });
    if (!session.ok) throw new Error("session preparation failed");
    const loaded = createDeferred();
    const release = createDeferred();
    let current = true;
    const readSpy = vi.spyOn(stores, "withGatewaySessionEntry");
    const run = historyPages.run.bind(historyPages);
    let exactReads = 0;
    vi.spyOn(historyPages, "run").mockImplementation(async (...args) => {
      const reply = await run(...args);
      if (
        reply.ok &&
        typeof reply.value === "object" &&
        !Array.isArray(reply.value) &&
        reply.value.kind === "session-exact-entries" &&
        ++exactReads === 2
      ) {
        loaded.resolve();
        await release.promise;
      }
      return reply;
    });
    const respond = vi.fn();
    const pending = admitChatSend({
      request: request.value,
      session: session.value,
      client: fixture.client,
      context: fixture.context,
      respond,
      assertCurrent: () => {
        if (!current) throw new Error("test caller revoked");
      },
    });
    let outcome: Awaited<typeof pending> | undefined;
    try {
      await loaded.promise;
      expect(fixture.context.chatAbortControllers.size).toBe(0);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      current = scenario !== "caller-revoked";
      if (scenario === "source-closed") {
        const source = stores.loadGatewaySessionEntryReadOnly(
          session.value.sessionLoadKey,
          session.value.sessionLoadOptions,
        ).readSource!;
        await closeOpenClawAgentDatabaseByPathAsync(source.path);
      }
      release.resolve();
      outcome = await pending;
      expect(outcome.ok).toBe(!revoke);
      expect(readSpy).toHaveBeenCalledTimes(2);
      if (revoke) {
        expect(fixture.context.chatAbortControllers.size).toBe(0);
        expect(fixture.context.dedupe.has(session.value.pendingChatSendKey)).toBe(false);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining(
              scenario === "caller-revoked" ? "test caller revoked" : "revoked",
            ),
          }),
        );
      }
    } finally {
      release.resolve();
      if (outcome?.ok) outcome.value.cleanupAdmittedRun();
      await fixture.cleanup();
    }
  },
);

it("reads the same alias-selected row off thread without main-thread session row SQL", async () => {
  const fixture = await createFixture();
  try {
    const expected = stores.loadGatewaySessionEntryReadOnly("main", { agentId: "main" });
    const database = openOpenClawAgentDatabase({
      agentId: expected.readSource!.agentId,
      path: expected.readSource!.path,
    });
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const spies = [
      vi.spyOn(prototype, "all"),
      vi.spyOn(prototype, "get"),
      vi.spyOn(prototype, "iterate"),
    ];
    try {
      const actual = await stores.withGatewaySessionEntry(
        "main",
        { agentId: "main" },
        (session) => session,
      );
      expect(actual).toEqual(expected);
      const rows = spies
        .flatMap((spy) =>
          spy.mock.contexts.map((statement) => (statement as StatementSync).sourceSQL),
        )
        .filter((sql) => /from ["`]?session_nodes["`]?/i.test(sql));
      expect(rows).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  } finally {
    await fixture.cleanup();
  }
});
