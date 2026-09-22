import type { Result } from "@openclaw/normalization-core/result";
import { expect, vi } from "vitest";
import {
  validateMentionsListResult,
  type ErrorShape,
  type MentionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SessionEntry } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as storeWriter from "../shared/store-writer-queue.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { ensureProfileForEmail, setDisplayName } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { MentionCommittedInput } from "./mention-inbox-worker-contract.js";
import { createMentionInbox } from "./mention-inbox.js";
import type { MentionInbox } from "./mention-inbox.types.js";
import { mentionHandlers } from "./server-methods/mentions.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { usersMentionableHandlers } from "./server-methods/users-mentionable.js";
import { createSessionRowProjection } from "./session-row-projection.js";

export const SESSION_KEY = "agent:main:dashboard:mention-test";
export const SESSION_ID = "mention-test-session";
const handlers = { ...mentionHandlers, ...usersMentionableHandlers };
type InboxFixtureOptions = { notifications?: boolean; beforeInbox?: () => void };

export async function withMentionInbox(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  cfg: OpenClawConfig = {},
  options: InboxFixtureOptions = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await createFixture(cfg, options);
    try {
      await run(fixture);
    } finally {
      await fixture.dispose();
      vi.useRealTimers();
    }
  });
}

async function createFixture(cfg: OpenClawConfig, options: InboxFixtureOptions) {
  const alice = ensureProfileForEmail("alice@mentions.example.test");
  const bob = ensureProfileForEmail("bob@mentions.example.test");
  const carol = ensureProfileForEmail("carol@mentions.example.test");
  setDisplayName(alice.id, "Alice");
  setDisplayName(bob.id, "Bob");
  setDisplayName(carol.id, "Carol");
  const aliceClient = { ...identifiedClient(alice.id, "Alice"), connId: "alice" };
  const bobClient = { ...identifiedClient(bob.id, "Bob"), connId: "bob-one" };
  const bobSecond = { ...identifiedClient(bob.id, "Bob"), connId: "bob-two" };
  const carolClient = { ...identifiedClient(carol.id, "Carol"), connId: "carol" };
  const clients: GatewayClient[] = [aliceClient, bobClient, bobSecond, carolClient];
  const broadcast = vi.fn();
  const push = vi.fn<NonNullable<Parameters<typeof createMentionInbox>[0]["onMentionCreated"]>>();
  const setSession = (entry: Partial<SessionEntry>, sessionKey = SESSION_KEY) =>
    upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: SESSION_ID,
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: alice.id },
        ...entry,
      },
    );
  await setSession({ displayName: "Design review" });
  let projection = await createSessionRowProjection({ cfg, getConfig: () => cfg });
  const inboxes = new Set<MentionInbox>();
  const openInbox = (gatewayInstanceId = "mention-gateway") => {
    const inbox = createMentionInbox({
      gatewayInstanceId,
      getRuntimeConfig: () => cfg,
      getSessionRowProjection: () => projection,
      getClients: () => clients,
      broadcastToConnIds: broadcast,
      onMentionCreated: options.notifications === false ? undefined : push,
    });
    inboxes.add(inbox);
    return inbox;
  };
  options.beforeInbox?.();
  const committedSources = new Map<string, MentionCommittedInput["committedSource"]>();
  const inbox = openInbox();
  const context = { mentionInbox: inbox, getRuntimeConfig: () => cfg } as GatewayRequestContext;
  async function call(
    method: string,
    params: Record<string, unknown>,
    client: GatewayClient = bobClient,
    onResponse?: GatewayRequestHandlerOptions["respond"],
  ) {
    let response: { ok: boolean; payload?: unknown; error?: ErrorShape } | undefined;
    // Mention publication tests depend on dispatch staying in the current stack.
    // Only involvement tests need the broader session mutation runtime.
    const handler =
      method === "sessions.setInvolvement"
        ? (await import("./server-methods/sessions-mutations.js")).sessionMutationHandlers[method]
        : handlers[method];
    if (!handler) {
      throw new Error(`Missing test method ${method}`);
    }
    await handler({
      req: { type: "req", id: "mention-test", method, params },
      client,
      params,
      context,
      isWebchatConnect: () => true,
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
        onResponse?.(ok, payload, error);
      },
    });
    if (!response) {
      throw new Error(`${method} did not respond`);
    }
    return response;
  }
  return {
    alice,
    bob,
    carol,
    aliceClient,
    bobClient,
    bobSecond,
    carolClient,
    clients,
    inbox,
    projection,
    call,
    broadcast,
    push,
    setSession,
    openInbox,
    async refreshProjection() {
      projection.dispose();
      projection = await createSessionRowProjection({ cfg, getConfig: () => cfg });
    },
    async dispose() {
      try {
        const settled = await Promise.allSettled(
          [...inboxes].map((instance) => instance.dispose()),
        );
        const failures = settled.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(failures, "Mention Inbox fixture did not drain");
        }
      } finally {
        projection.dispose();
      }
    },
    post(sourceId = "source-one", overrides: Partial<MentionCommittedInput> = {}, target = inbox) {
      let committedSource = committedSources.get(sourceId);
      if (!committedSource) {
        committedSource = {
          generation: "test-generation",
          sequence: committedSources.size + 1,
          timestamp: Date.now(),
        };
        committedSources.set(sourceId, committedSource);
      }
      return target.recordCommittedInput({
        sourceId,
        committedSource,
        sessionKey: SESSION_KEY,
        agentId: "main",
        sessionId: SESSION_ID,
        messageId: `message-${sourceId}`,
        senderProfileId: alice.id,
        recipientProfileIds: [bob.id],
        excerpt: "@Bob review **this change**",
        ...overrides,
      });
    },
  };
}

export async function listMentionInbox(inbox: MentionInbox, client: GatewayClient) {
  let result: Result<MentionsListResult, ErrorShape> | undefined;
  await inbox.list(client, (value) => {
    result = value;
  });
  if (!result) {
    throw new Error("Mention result was not published");
  }
  return result;
}

export async function dismissMentionInbox(
  inbox: MentionInbox,
  client: GatewayClient,
  ids: readonly string[],
) {
  let result: Result<MentionsListResult, ErrorShape> | undefined;
  await inbox.dismiss(client, ids, (value) => {
    result = value;
  });
  if (!result) {
    throw new Error("Mention dismissal result was not published");
  }
  return result;
}

export async function readMentionInbox(inbox: MentionInbox, client: GatewayClient) {
  const result = await listMentionInbox(inbox, client);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  expect(validateMentionsListResult(result.value)).toBe(true);
  return result.value;
}

/** Observe the real queue owner; timer tests join work without issuing an Inbox read. */
export function observeMentionInboxWork() {
  const enqueue = storeWriter.runQueuedStoreWrite;
  const pending = new Set<Promise<unknown>>();
  const spy = vi
    .spyOn(storeWriter, "runQueuedStoreWrite")
    .mockImplementation(<T>(params: Parameters<typeof enqueue<T>>[0]) => {
      const result = enqueue(params);
      if (params.label === "mention Inbox") {
        const settled = result.then(
          () => {},
          () => {},
        );
        pending.add(settled);
        void settled.then(() => pending.delete(settled));
      }
      return result;
    });
  return {
    async settle() {
      while (pending.size) {
        await Promise.all(pending);
      }
    },
    restore: () => spy.mockRestore(),
  };
}

/** Hold only the next real mention worker reply; unrelated state readers retain their owner. */
export function holdMentionInboxRead() {
  const execute = stateReads.executeExistingOpenClawStateRead;
  const ready = createDeferred();
  const release = createDeferred();
  let held = false;
  const spy = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementation(async (...args) => {
      if (held || args[1].type !== "mentions.read") {
        return execute(...args);
      }
      held = true;
      const result = await execute(...args).then(
        (value) => {
          ready.resolve();
          return value;
        },
        (error: unknown) => {
          ready.reject(error);
          throw error;
        },
      );
      await release.promise;
      return result;
    });
  return { ready: ready.promise, release: release.resolve, restore: () => spy.mockRestore() };
}
