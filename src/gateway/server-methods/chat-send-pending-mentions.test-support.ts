import type { Result } from "@openclaw/normalization-core/result";
import { expect, it, vi } from "vitest";
import type {
  ErrorShape,
  MentionsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { ensureProfileForEmail, setDisplayName } from "../../state/user-profiles.js";
import { createMentionInbox } from "../mention-inbox.js";
import type { MentionInbox } from "../mention-inbox.types.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { dispatchInboundMessageMock } from "../test-helpers.js";
import type { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

async function listMentions(inbox: MentionInbox, client: GatewayClient) {
  let result: Result<MentionsListResult, ErrorShape> | undefined;
  await inbox.list(client, (value) => {
    result = value;
  });
  if (!result) {
    throw new Error("Mention result was not published");
  }
  return result;
}

export function createPendingMentionFixture(
  createBrowserFollowupFixture: ReturnType<typeof useBrowserFollowupFixture>,
) {
  return async function createMentionFixture(
    options: { active?: boolean; preserveContent?: boolean } = {},
  ) {
    const fixture = await createBrowserFollowupFixture({ preserveContent: true, ...options });
    const profiles = ["Alice", "Bob", "Carol"].map((name) => {
      const profile = ensureProfileForEmail(`${name.toLowerCase()}@mentions.example.test`);
      setDisplayName(profile.id, name);
      return { profileId: profile.id, displayName: name, hasAvatar: false, updatedAt: 1 };
    });
    const [alice, bob, carol] = profiles;
    if (!alice || !bob || !carol) {
      throw new Error("Mention test profiles were not created");
    }
    fixture.client.authenticatedUserProfile = alice;
    const bobClient = { ...fixture.client, connId: "bob-one", authenticatedUserProfile: bob };
    const carolClient = { ...fixture.client, connId: "carol", authenticatedUserProfile: carol };
    const projection = await createSessionRowProjection({
      cfg: getRuntimeConfig(),
      getConfig: getRuntimeConfig,
    });
    const inbox = createMentionInbox({
      gatewayInstanceId: "chat-mention-commit-test",
      getRuntimeConfig,
      getSessionRowProjection: () => projection,
      getClients: () => [fixture.client, bobClient, carolClient],
      broadcastToConnIds: vi.fn(),
    });
    fixture.context.mentionInbox = inbox;
    fixture.params.message = "@Bob could you review this?";
    fixture.params.mentions = [{ profileId: bob.profileId, start: 0, end: 4 }];
    const read = async (client: GatewayClient = bobClient) => {
      const result = await listMentions(inbox, client);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value.items;
    };
    return {
      ...fixture,
      bobClient,
      carolClient,
      inbox,
      projection,
      read,
      cleanup: async () => {
        try {
          await fixture.cleanup();
        } finally {
          try {
            await inbox.dispose();
          } finally {
            projection.dispose();
          }
        }
      },
    };
  };
}

/** Register mention admission cases within the existing pending-input harness and lifecycle. */
export function registerChatSendPendingMentionTests(
  createBrowserFollowupFixture: ReturnType<typeof useBrowserFollowupFixture>,
) {
  const createMentionFixture = createPendingMentionFixture(createBrowserFollowupFixture);

  it.each([false, true])(
    "settles everyone custody before the queued ACK (failure: %s)",
    async (failRetention) => {
      const fixture = await createMentionFixture();
      fixture.params.message = "@everyone review this";
      fixture.params.mentions = [{ kind: "everyone", start: 0, end: 9 }];
      const retaining = createDeferred();
      const release = createDeferred();
      const retain = fixture.inbox.retainEveryoneAudience;
      vi.spyOn(fixture.inbox, "retainEveryoneAudience").mockImplementation(async (...args) => {
        retaining.resolve();
        await release.promise;
        if (failRetention) {
          throw new Error("audience persistence failed");
        }
        await retain(...args);
      });
      const respond = vi.fn<RespondFn>();
      const sending = fixture.send(respond, {
        expectedProfileId: fixture.client.authenticatedUserProfile!.profileId,
      });
      try {
        await Promise.race([
          retaining.promise,
          sending.then(() => {
            throw new Error(
              "chat.send responded before retaining its audience: " +
                JSON.stringify(respond.mock.calls),
            );
          }),
        ]);
        expect(respond).not.toHaveBeenCalled();
        expect(listSessionPendingInputs(fixture.scope).items).toEqual([]);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        release.resolve();
        await sending;
        expect(respond.mock.calls[0]?.[0]).toBe(!failRetention);
        expect(listSessionPendingInputs(fixture.scope).items).toHaveLength(failRetention ? 0 : 1);
      } finally {
        release.resolve();
        await sending;
        await fixture.cleanup();
      }
    },
  );

  it.each([false, true])(
    "commits an explicit everyone snapshot once (queued: %s)",
    async (active) => {
      const fixture = await createMentionFixture({ active });
      fixture.params.message = "@everyone @Bob review this";
      fixture.params.mentions = [
        { kind: "everyone", start: 0, end: 9 },
        { profileId: fixture.bobClient.authenticatedUserProfile.profileId, start: 10, end: 14 },
      ];
      const offline = ensureProfileForEmail("offline-broadcast@mentions.example.test");
      const offlineClient = {
        ...fixture.bobClient,
        connId: "offline-broadcast",
        authenticatedUserProfile: {
          profileId: offline.id,
          displayName: "Offline",
          hasAvatar: false,
          updatedAt: 1,
        },
      };
      try {
        const ack = await fixture.send(vi.fn<RespondFn>(), {
          expectedProfileId: fixture.client.authenticatedUserProfile!.profileId,
        });
        expect(ack).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "started" }),
          undefined,
          expect.anything(),
        );
        if (active) {
          expect(await fixture.read()).toEqual([]);
        }
        const late = ensureProfileForEmail("late-broadcast@mentions.example.test");
        const recorder = await fixture.dispatchedRecorder;
        const committed = await recorder.persistApproved();
        expect(await fixture.read()).toHaveLength(1);
        expect(await fixture.read(fixture.carolClient)).toHaveLength(1);
        expect(await fixture.read(offlineClient)).toHaveLength(1);
        expect(await fixture.read(fixture.client)).toEqual([]);
        const stored = JSON.stringify(committed?.message ?? recorder.getPersistedMessage?.());
        expect(stored).not.toContain(offline.id);
        expect(stored).not.toContain(late.id);
        expect(stored).not.toContain("everyoneMentionProfileIds");
        const id = (await fixture.read())[0]!.id;
        await fixture.inbox.dismiss(fixture.bobClient, [id], () => {});
        await fixture.send();
        await recorder.persistApproved();
        expect(await fixture.read()).toEqual([]);
        expect(
          await fixture.read({
            ...offlineClient,
            authenticatedUserProfile: {
              ...offlineClient.authenticatedUserProfile,
              profileId: late.id,
            },
          }),
        ).toEqual([]);
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(["empty", "oversized", "truncated", "unavailable"] as const)(
    "recovers the accepted everyone audience when the current roster is %s",
    async (roster) => {
      const fixture = await createMentionFixture();
      const resumedRelease = createDeferred();
      const resumedReady = createDeferred<UserTurnTranscriptRecorder>();
      fixture.params.message = "@everyone review this";
      fixture.params.mentions = [{ kind: "everyone", start: 0, end: 9 }];
      try {
        expect((await fixture.send()).mock.calls[0]?.[0]).toBe(true);
        const originalRecorder = await fixture.dispatchedRecorder;
        const rejectFreshRoster = (inbox: typeof fixture.inbox) => {
          const failure = {
            ok: false as const,
            error: errorShape(
              roster === "unavailable" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
              `Current everyone roster is ${roster}`,
            ),
          };
          const prepare = inbox.prepareRecipients;
          const read = vi.fn(() => failure);
          if (roster === "unavailable") {
            // Only roster preparation is unavailable; current target authorization
            // still runs for recovered input and must not be replaced by this fault.
            vi.spyOn(inbox, "prepareRecipients").mockImplementation((everyone) =>
              everyone ? Promise.resolve(read()) : prepare(false),
            );
          } else {
            vi.spyOn(inbox, "resolveEveryoneRecipients").mockImplementation(read);
          }
          return read;
        };
        const binding = { expectedProfileId: fixture.client.authenticatedUserProfile!.profileId };
        const rosterRead = rejectFreshRoster(fixture.inbox);
        if (roster === "unavailable") {
          const wrongSender = await fixture.send(vi.fn<RespondFn>(), {
            expectedProfileId: fixture.bobClient.authenticatedUserProfile.profileId,
          });
          expect(wrongSender.mock.calls[0]?.[2]?.details).toMatchObject({
            reason: "EXPECTED_PROFILE_MISMATCH",
          });
          const entry = loadSessionEntry(fixture.scope)!;
          const scopes = fixture.client.connect.scopes;
          fixture.client.connect.scopes = ["operator.read", "operator.write"];
          replaceSessionEntrySync(fixture.scope, {
            ...entry,
            visibility: "draft",
            createdActor: {
              type: "human",
              source: "profile",
              id: fixture.bobClient.authenticatedUserProfile.profileId,
            },
          });
          const forbiddenSession = await fixture.send(vi.fn<RespondFn>(), binding);
          expect(forbiddenSession.mock.calls[0]?.[0]).toBe(false);
          replaceSessionEntrySync(fixture.scope, entry);
          fixture.client.connect.scopes = scopes;
        }
        // An accepted same-ID retry must not expand or validate a new broadcast audience.
        expect((await fixture.send(vi.fn<RespondFn>(), binding)).mock.calls[0]?.[0]).toBe(true);
        fixture.params.message += " changed";
        const conflict = await fixture.send(vi.fn<RespondFn>(), binding);
        expect(conflict.mock.calls[0]?.[2]?.details).toMatchObject({
          reason: "chat-request-conflict",
        });
        fixture.params.message = "@everyone review this";
        expect(rosterRead).not.toHaveBeenCalled();
        const original = listSessionPendingInputs(fixture.scope).items[0];
        expect(original).toBeDefined();
        const pendingJson = JSON.stringify(original);
        expect(pendingJson).not.toContain(fixture.bobClient.authenticatedUserProfile.profileId);
        expect(pendingJson).not.toContain(fixture.carolClient.authenticatedUserProfile.profileId);
        rotateAgentEventLifecycleGeneration();
        await fixture.finishDispatch();
        fixture.context.dedupe.clear();
        await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
        const originalClock = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(originalClock + 8 * 24 * 60 * 60_000);
        await fixture.inbox.dispose();
        const reopened = createMentionInbox({
          gatewayInstanceId: "restarted-private-audience",
          getRuntimeConfig,
          getSessionRowProjection: () => fixture.projection,
          getClients: () => [fixture.client, fixture.bobClient, fixture.carolClient],
          broadcastToConnIds: vi.fn(),
        });
        fixture.context.mentionInbox = reopened;
        const reopenedRosterRead = rejectFreshRoster(reopened);
        const late = ensureProfileForEmail("late-after-restart@example.test");
        dispatchInboundMessageMock.mockImplementation(async (options: unknown) => {
          const { replyOptions } = options as Parameters<typeof dispatchInboundMessage>[0];
          const recorder = replyOptions?.userTurnTranscriptRecorder;
          if (!recorder) {
            throw new Error("Expected the recovered user-turn recorder");
          }
          resumedReady.resolve(recorder);
          await resumedRelease.promise;
          return {};
        });
        Object.assign(fixture.params, { __controlUiReconnectResume: true });
        expect((await fixture.send(vi.fn<RespondFn>(), binding)).mock.calls[0]?.[0]).toBe(true);
        expect(reopenedRosterRead).not.toHaveBeenCalled();
        const resumedRecorder = await resumedReady.promise;
        expect(() => originalRecorder.withPendingInput?.(() => {})).toThrow("ownership ended");
        const committed = await resumedRecorder.persistApproved();
        expect(JSON.stringify(committed?.message)).not.toContain(
          fixture.bobClient.authenticatedUserProfile.profileId,
        );
        const bob = await listMentions(reopened, fixture.bobClient);
        const lateView = await listMentions(reopened, {
          ...fixture.bobClient,
          authenticatedUserProfile: {
            ...fixture.bobClient.authenticatedUserProfile,
            profileId: late.id,
          },
        });
        expect(bob.ok && bob.value.items).toHaveLength(1);
        expect(lateView.ok && lateView.value.items).toEqual([]);
        await reopened.dispose();
        clock.mockRestore();
      } finally {
        vi.restoreAllMocks();
        resumedRelease.resolve();
        await fixture.context.mentionInbox?.dispose();
        await fixture.cleanup();
      }
    },
  );

  it("binds a new-session broadcast to the real runtime-created incarnation", async () => {
    const fixture = await createMentionFixture({ active: false });
    const release = createDeferred();
    const committed = createDeferred();
    const retaining = createDeferred();
    const retained = createDeferred();
    const retain = fixture.inbox.retainEveryoneAudience;
    vi.spyOn(fixture.inbox, "retainEveryoneAudience").mockImplementation(async (...args) => {
      retaining.resolve();
      await retained.promise;
      await retain(...args);
    });
    const record = vi.spyOn(fixture.inbox, "recordCommittedInput");
    fixture.params.sessionKey = "agent:main:dashboard:new-everyone";
    delete fixture.params.sessionId;
    fixture.params.message = "@everyone review this";
    fixture.params.mentions = [{ kind: "everyone", start: 0, end: 9 }];
    dispatchInboundMessageMock.mockImplementation(async (options: unknown) => {
      const { replyOptions } = options as Parameters<typeof dispatchInboundMessage>[0];
      const scope = {
        ...fixture.scope,
        sessionKey: fixture.params.sessionKey,
        sessionId: "actual-runtime-session",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: {
          type: "human",
          source: "profile",
          id: fixture.client.authenticatedUserProfile!.profileId,
        },
      });
      replyOptions?.onSessionPrepared?.(scope);
      await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
      committed.resolve();
      await release.promise;
      return {};
    });
    try {
      const sending = fixture.send(vi.fn<RespondFn>(), {
        expectedProfileId: fixture.client.authenticatedUserProfile!.profileId,
      });
      await Promise.race([
        retaining.promise,
        sending.then((ack) => {
          if (ack.mock.calls[0]?.[0] !== true) {
            throw new Error("New-session admission failed: " + JSON.stringify(ack.mock.calls));
          }
          return retaining.promise;
        }),
      ]);
      expect(record).not.toHaveBeenCalled();
      retained.resolve();
      const ack = await sending;
      expect(ack.mock.calls[0]?.[0]).toBe(true);
      await committed.promise;
      expect(record).toHaveBeenCalledOnce();
      expect(await fixture.read()).toHaveLength(1);
      expect((await fixture.read())[0]?.sessionKey).toBe(fixture.params.sessionKey);
      expect(await fixture.read(fixture.carolClient)).toHaveLength(1);
    } finally {
      retained.resolve();
      release.resolve();
      await fixture.cleanup();
    }
  });

  it("keeps typed everyone inert through the registered chat.send entrypoint", async () => {
    const fixture = await createMentionFixture({ active: false });
    fixture.params.message = "@everyone review this";
    delete fixture.params.mentions;
    try {
      await fixture.send();
      await fixture.finishDispatch();
      expect(await fixture.read()).toEqual([]);
      expect(await fixture.read(fixture.carolClient)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rechecks access at everyone commit", async () => {
    const fixture = await createMentionFixture();
    fixture.params.message = "@everyone review this";
    fixture.params.mentions = [{ kind: "everyone", start: 0, end: 9 }];
    try {
      await fixture.send();
      const entry = loadSessionEntry(fixture.scope);
      if (!entry) {
        throw new Error("Missing fixture session");
      }
      replaceSessionEntrySync(fixture.scope, {
        ...entry,
        visibility: "draft",
        createdActor: {
          type: "human",
          source: "profile",
          id: fixture.client.authenticatedUserProfile!.profileId,
        },
      });
      const recorder = await fixture.dispatchedRecorder;
      await recorder.persistApproved();
      expect(await fixture.read()).toEqual([]);
      expect(await fixture.read(fixture.carolClient)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("creates recipient-only mentions at original message commit, never at the queued ACK", async () => {
    const fixture = await createMentionFixture();
    try {
      const ack = await fixture.send();
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.anything(),
      );
      expect(await fixture.read()).toEqual([]);
      const recorder = await fixture.dispatchedRecorder;
      const committed = await recorder.persistApproved();
      expect(committed?.appended).toBe(true);
      expect(await fixture.read()).toMatchObject([
        {
          messageId: committed?.messageId,
          senderProfileId: fixture.client.authenticatedUserProfile?.profileId,
          excerpt: fixture.params.message,
        },
      ]);
      expect(await fixture.read(fixture.client)).toEqual([]);
      expect(await fixture.read(fixture.carolClient)).toEqual([]);
      const id = (await fixture.read())[0]?.id;
      expect(id).toBeDefined();
      await fixture.inbox.dismiss(fixture.bobClient, id ? [id] : [], () => {});
      await recorder.persistApproved();
      await fixture.send();
      expect(await fixture.read()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("includes an idle first commit in the Inbox before ACK without waiting for the agent", async () => {
    const fixture = await createMentionFixture({ active: false });
    let committed = false;
    let atAck = false;
    const record = fixture.inbox.recordCommittedInput;
    vi.spyOn(fixture.inbox, "recordCommittedInput").mockImplementation(async (input) => {
      await record(input);
      committed = true;
    });
    try {
      const ack = await fixture.send(
        vi.fn((ok) => {
          if (ok) {
            atAck = committed;
          }
        }),
      );
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started", messageSeq: 2 }),
        undefined,
        expect.anything(),
      );
      expect(atAck).toBe(true);
      await fixture.finishDispatch();
      expect(await fixture.read()).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([false, true])(
    "does not notify when approval replaces the selected token (everyone: %s)",
    async (everyone) => {
      const fixture = await createMentionFixture({ preserveContent: false });
      if (everyone) {
        fixture.params.message = "@everyone review this";
        fixture.params.mentions = [{ kind: "everyone", start: 0, end: 9 }];
      }
      try {
        await fixture.send();
        const recorder = await fixture.dispatchedRecorder;
        const committed = await recorder.persistApproved();
        expect(committed?.message.content).toBe(fixture.approvedContent);
        expect(committed?.message["__openclaw"]?.humanMentions).toBeUndefined();
        expect(committed?.message["__openclaw"]?.everyoneMentionProfileIds).toBeUndefined();
        expect(await fixture.read()).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("rejects changed recipients on a same-ID retry while preserving the queued original", async () => {
    const fixture = await createMentionFixture();
    try {
      await fixture.send();
      fixture.params.mentions = [
        { profileId: fixture.carolClient.authenticatedUserProfile.profileId, start: 0, end: 4 },
      ];
      const replay = await fixture.send();
      expect(replay).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringMatching(/different|conflict|reused/i) }),
      );
      const recorder = await fixture.dispatchedRecorder;
      await recorder.persistApproved();
      expect(await fixture.read()).toHaveLength(1);
      expect(await fixture.read(fixture.carolClient)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
}
