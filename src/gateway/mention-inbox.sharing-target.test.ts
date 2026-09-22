import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  observeMentionInboxWork,
  SESSION_KEY,
  withMentionInbox,
  readMentionInbox,
} from "./mention-inbox.test-support.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";

afterEach(() => vi.restoreAllMocks());

it("refreshes 50 connected mention views without rereading unchanged session targets", async () => {
  await withMentionInbox(
    async (f) => {
      f.clients.splice(
        0,
        f.clients.length,
        ...Array.from({ length: 50 }, (_, index) => ({
          ...f.bobClient,
          connId: `viewer-${index}`,
        })),
      );
      await f.post();
      for (const client of f.clients) {
        expect((await readMentionInbox(f.inbox, client)).items).toHaveLength(1);
      }
      const work = observeMentionInboxWork();
      f.broadcast.mockClear();
      let exactRowReads = 0;
      // oxlint-disable-next-line typescript/unbound-method -- apply preserves the intercepted statement receiver.
      const originalGet = StatementSync.prototype.get;
      vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (
        this: StatementSync,
        ...values
      ) {
        // The event producer probes its unrelated missing key for projection
        // discovery. Count only this Inbox target, not that separate owner.
        if (/from "session_nodes"/i.test(this.sourceSQL) && values.includes(SESSION_KEY)) {
          exactRowReads++;
        }
        return originalGet.apply(this, values);
      });
      const context: Parameters<typeof emitSessionsChanged>[0] = {
        mentionInbox: f.inbox,
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set(),
        broadcastToConnIds: f.broadcast,
        chatAbortControllers: new Map(),
      };
      const emit = (sessionKey = "agent:main:unrelated") =>
        emitSessionsChanged(context, { sessionKey, agentId: "main", reason: "patch" });
      const start = performance.now();
      emit();
      await work.settle();
      const elapsed = performance.now() - start;
      const reads = exactRowReads;
      console.log(
        JSON.stringify({ viewers: f.clients.length, exactRowReads: reads, elapsedMs: elapsed }),
      );
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(reads).toBe(0);

      // The owner publication must invalidate even if the next fan-out names another session.
      exactRowReads = 0;
      await f.setSession({ visibility: "draft" });
      await f.projection.ensureMaterialized();
      const mutationReads = exactRowReads;
      emit();
      await work.settle();
      // The mutation and its committed projection publication own their reads;
      // the 50-view Inbox refresh must add none.
      expect(exactRowReads).toBe(mutationReads);
      expect(f.broadcast).toHaveBeenCalledTimes(50);
      expect((await readMentionInbox(f.inbox, f.bobClient)).items).toEqual([]);

      exactRowReads = 0;
      f.broadcast.mockClear();
      await f.setSession({ displayName: "Renamed conversation" });
      emit(SESSION_KEY);
      await f.projection.ensureMaterialized();
      const publicationReads = exactRowReads;
      await work.settle();
      expect(exactRowReads).toBe(publicationReads);
      expect(f.broadcast).toHaveBeenCalledTimes(50);
      expect((await readMentionInbox(f.inbox, f.bobClient)).items[0]?.sessionTitle).toBe(
        "Renamed conversation",
      );

      // Target reuse never retains the viewer's identity or authorization decision.
      f.clients[0]!.authenticatedUserProfile = f.carolClient.authenticatedUserProfile;
      exactRowReads = 0;
      f.broadcast.mockClear();
      emit();
      await work.settle();
      expect(exactRowReads).toBe(0);
      expect(f.broadcast).toHaveBeenCalledTimes(1);
      expect([...f.broadcast.mock.calls[0]![2]]).toEqual(["viewer-0"]);

      // Keyless invalidation also covers in-place runtime configuration updates.
      exactRowReads = 0;
      f.inbox.invalidate();
      await work.settle();
      expect(exactRowReads).toBe(0);
    },
    {},
    { notifications: false },
  );
});
