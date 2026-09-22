import "../../llm/ai-transport-host.js";
import { notifyProviderHttpMetadata } from "@openclaw/ai/transports";
import type { Model } from "@openclaw/llm-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { ChatAbortParams } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { recordAgentCleanupFailure } from "../../agents/run-cleanup-timeout.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import {
  getSessionWorkAdmissionRelease,
  isSessionWorkAdmissionActive,
} from "../../sessions/session-lifecycle-admission.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { handleGatewayRequest } from "../server-methods.js";
import { startGatewayEventSubscriptions } from "../server-runtime-subscriptions.js";
import { createSubscriptionTestFixture } from "../server-runtime-subscriptions.test-support.js";
import { dispatchInboundMessageMock, installGatewayTestHooks, testState } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { withForegroundChatAuthority } from "./chat-send-foreground.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();

async function createForegroundFixture(timeoutSeconds = 30) {
  // Session setup publishes the fixture's first runtime snapshot.
  testState.agentConfig = { ...testState.agentConfig, timeoutSeconds };
  const fixture = await createFixture({ active: false });
  try {
    expect(fixture.context.getRuntimeConfig().agents?.defaults?.timeoutSeconds).toBe(
      timeoutSeconds,
    );
    return fixture;
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}

it("expires the original foreground clock across waits and repeated captures", async () => {
  const fixture = await createForegroundFixture(2);
  const profile = ensureProfileForEmail("deadline-visitor@example.test");
  fixture.client.authenticatedUserProfile = {
    profileId: profile.id,
    displayName: null,
    hasAvatar: false,
    updatedAt: profile.updatedAt,
  };
  fixture.client.internal = {
    operatorAccessAuthority: {
      executionPolicy: "foreground-only",
      signal: new AbortController().signal,
      assertCurrent: () => undefined,
    },
  };
  const params = { ...fixture.params, timeoutMs: 1_000 };
  const respond = vi.fn();
  try {
    await withForegroundChatAuthority(
      {
        req: { type: "req", id: params.idempotencyKey, method: "chat.send", params },
        params,
        client: fixture.client,
        context: fixture.context,
        respond,
        isWebchatConnect: () => true,
      },
      async (original) => {
        const authority = original.client?.internal?.operatorRunAuthority;
        expect(authority?.foregroundDeadlineAt).toBeGreaterThan(Date.now());
        await withForegroundChatAuthority(
          { ...original, params: { ...params, timeoutMs: 30_000 } },
          async (retry) => {
            const retained = retry.client?.internal?.operatorRunAuthority;
            expect(retained?.foregroundDeadlineAt).toBe(authority?.foregroundDeadlineAt);
            const signal = retained?.signal;
            if (!retained || !signal) {
              throw new Error("Expected the real foreground deadline signal");
            }
            if (!signal.aborted) {
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
            expect(signal.aborted).toBe(true);
            expect(() => retained.assertCurrent()).toThrow();
            expect(() => authority?.assertCurrent()).toThrow();
            const next = vi.fn(async () => undefined);
            await expect(withForegroundChatAuthority(retry, next)).rejects.toThrow();
            expect(next).not.toHaveBeenCalled();
          },
        );
      },
    );
    expect(respond).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(loadSessionEntry(fixture.scope)?.foregroundRun).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

it.each([false, true])(
  "retains custody through real tails and refuses reuse when cleanup is uncertain (%s)",
  async (uncertain) => {
    const fixture = await createForegroundFixture();
    const subscriptionAbort = new AbortController();
    // Stop persists terminal state through the same subscription owner as a live Gateway.
    const subscriptions = startGatewayEventSubscriptions({
      ...createSubscriptionTestFixture().createParams(),
      signal: subscriptionAbort.signal,
      broadcast: fixture.context.broadcast,
      broadcastToConnIds: fixture.context.broadcastToConnIds,
      nodeSendToSession: fixture.context.nodeSendToSession,
      agentRunSeq: fixture.context.agentRunSeq,
      chatRunState: fixture.context.chatRunState,
      toolEventRecipients: fixture.context.chatRunState.toolEventRecipients,
      chatAbortControllers: fixture.context.chatAbortControllers,
    });
    const profile = ensureProfileForEmail("draining-visitor@example.test");
    fixture.client.authenticatedUserProfile = {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    };
    fixture.client.internal = {
      operatorAccessAuthority: {
        executionPolicy: "foreground-only",
        signal: new AbortController().signal,
        assertCurrent: () => undefined,
      },
    };
    const model: Model = {
      id: "controlled-provider",
      name: "Controlled provider",
      provider: "test",
      api: "openai-responses",
      baseUrl: "https://provider.example.test",
      reasoning: false,
      input: ["text"],
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const callback = createDeferred();
    const cancellation = createDeferred();
    const entered = createDeferred();
    const cancelled = createDeferred();
    const notificationSettled = createDeferred();
    let notifications = 0;
    dispatchInboundMessageMock.mockImplementation(async (dispatchParams: unknown) => {
      const replyOptions = asOptionalRecord(asOptionalRecord(dispatchParams)?.replyOptions);
      const signal = replyOptions?.abortSignal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("Expected dispatch to retain the admitted foreground AbortSignal");
      }
      notifications += 1;
      if (notifications > 1) {
        return {};
      }
      const cleanupTail = cancellation.promise.then(() => {
        if (uncertain) {
          recordAgentCleanupFailure();
        }
      });
      try {
        await notifyProviderHttpMetadata({
          options: {
            signal,
            onResponse: () => {
              entered.resolve();
              return callback.promise;
            },
          },
          response: { status: 200, headers: {} },
          model,
          cancelStream: () => {
            cancelled.resolve();
            return cleanupTail;
          },
        });
        return {};
      } finally {
        notificationSettled.resolve();
      }
    });
    const originalRunId = fixture.params.idempotencyKey;
    const busy = () =>
      isSessionWorkAdmissionActive(fixture.scope.storePath, [
        fixture.scope.sessionKey,
        fixture.scope.sessionId,
      ]);
    try {
      const accepted = await fixture.send();
      expect(
        accepted.mock.calls.some(([ok]) => ok),
        JSON.stringify(accepted.mock.calls),
      ).toBe(true);
      const admittedMarker = loadSessionEntry(fixture.scope)?.foregroundRun;
      expect(admittedMarker).toMatchObject({ runId: originalRunId });
      await entered.promise;
      const respond = vi.fn();
      const params: ChatAbortParams = {
        sessionKey: fixture.scope.sessionKey,
        runId: originalRunId,
      };
      await handleGatewayRequest({
        req: { type: "req", id: "stop-foreground", method: "chat.abort", params },
        client: fixture.client,
        context: fixture.context,
        respond,
        isWebchatConnect: () => true,
        extraHandlers: { "chat.abort": handleChatAbortRequest },
      });
      expect(
        respond.mock.calls.some(([ok]) => ok),
        JSON.stringify(respond.mock.calls),
      ).toBe(true);
      await cancelled.promise;
      await notificationSettled.promise;
      await vi.waitFor(() =>
        expect(fixture.context.chatAbortControllers.has(originalRunId)).toBe(false),
      );
      expect(busy()).toBe(true);
      const inputIds = listSessionPendingInputs(fixture.scope).items.map((item) => item.runId);
      fixture.params.idempotencyKey = "while-provider-drains";
      const firstBlocked = await fixture.send();
      expect(firstBlocked.mock.calls.some(([ok]) => ok)).toBe(false);
      expect(JSON.stringify(firstBlocked.mock.calls)).toContain("still running");
      expect(notifications).toBe(1);
      expect(listSessionPendingInputs(fixture.scope).items.map((item) => item.runId)).toEqual(
        inputIds,
      );
      callback.resolve();
      await callback.promise;
      expect(busy()).toBe(true);
      fixture.params.idempotencyKey = "while-cancellation-drains";
      const secondBlocked = await fixture.send();
      expect(secondBlocked.mock.calls.some(([ok]) => ok)).toBe(false);
      expect(notifications).toBe(1);
      const released = getSessionWorkAdmissionRelease({
        scope: fixture.scope.storePath,
        identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
      });
      expect(released).toBeDefined();
      cancellation.resolve();
      await released;
      expect(busy()).toBe(false);
      const settledEntry = loadSessionEntry(fixture.scope);
      expect(settledEntry).toMatchObject({ status: "killed", lastRunId: originalRunId });
      expect(settledEntry?.lifecycleRunId).toBeUndefined();
      expect(settledEntry?.foregroundRun).toEqual(admittedMarker);
      if (uncertain) {
        // Promotion cannot certify the former guest generation's unknown cleanup.
        fixture.client.internal = { operatorAccessAuthority: null };
        fixture.params.idempotencyKey = "staff-after-uncertain-cleanup";
        const refused = await fixture.send();
        expect(
          refused.mock.calls.some(([ok]) => ok),
          JSON.stringify(refused.mock.calls),
        ).toBe(false);
        expect(JSON.stringify(refused.mock.calls)).toContain("UNAVAILABLE");
        expect(JSON.stringify(refused.mock.calls)).toContain(
          "Cleanup of the previous turn could not be confirmed",
        );
        expect(JSON.stringify(refused.mock.calls)).not.toContain("restarted");
        expect(notifications).toBe(1);
        expect(loadSessionEntry(fixture.scope)).toMatchObject({
          status: "killed",
          lastRunId: originalRunId,
        });
        expect(loadSessionEntry(fixture.scope)?.foregroundRun).toEqual(admittedMarker);
        expect(listSessionPendingInputs(fixture.scope).items.map((item) => item.runId)).toEqual(
          inputIds,
        );
        return;
      }
      fixture.params.idempotencyKey = "fresh-after-drain";
      const fresh = await fixture.send();
      expect(
        fresh.mock.calls.some(([ok]) => ok),
        JSON.stringify(fresh.mock.calls),
      ).toBe(true);
      await vi.waitFor(() => expect(notifications).toBe(2));
    } finally {
      callback.resolve();
      cancellation.resolve();
      await Promise.all([callback.promise, cancellation.promise]);
      subscriptionAbort.abort();
      try {
        await fixture.cleanup();
      } finally {
        await subscriptions.agentUnsub();
        subscriptions.heartbeatUnsub();
        subscriptions.transcriptUnsub();
        subscriptions.lifecycleUnsub();
        await subscriptions.taskUnsub();
      }
    }
  },
);

it("cancels foreground preparation before the runtime reports that execution started", async () => {
  const fixture = await createForegroundFixture();
  const profile = ensureProfileForEmail("preparing-visitor@example.test");
  fixture.client.authenticatedUserProfile = {
    profileId: profile.id,
    displayName: null,
    hasAvatar: false,
    updatedAt: profile.updatedAt,
  };
  const source = new AbortController();
  fixture.client.internal = {
    operatorAccessAuthority: {
      executionPolicy: "foreground-only",
      signal: source.signal,
      assertCurrent: () => source.signal.throwIfAborted(),
    },
  };
  try {
    const response = await fixture.send();
    expect(
      response.mock.calls.some(([ok]) => ok),
      JSON.stringify(response.mock.calls),
    ).toBe(true);
    await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledOnce());
    // The fixture holds dispatch and never calls onAgentRunStart.
    const active = fixture.context.chatAbortControllers.get(fixture.params.idempotencyKey);
    expect(active).toBeDefined();
    expect(active?.controller.signal.aborted).toBe(false);
    source.abort(new Error("foreground deadline expired"));
    await vi.waitFor(() => expect(active?.controller.signal.aborted).toBe(true));
  } finally {
    await fixture.cleanup();
  }
});

it("settles the exact marker when authority expires after its commit but before accepted input", async () => {
  const fixture = await createForegroundFixture();
  const profile = ensureProfileForEmail("foreground-visitor@example.test");
  fixture.client.authenticatedUserProfile = {
    profileId: profile.id,
    displayName: null,
    hasAvatar: false,
    updatedAt: profile.updatedAt,
  };
  fixture.client.internal = {
    operatorAccessAuthority: {
      executionPolicy: "foreground-only",
      signal: new AbortController().signal,
      assertCurrent() {
        if (loadSessionEntry(fixture.scope)?.foregroundRun) {
          throw new Error("source expired after negative admission");
        }
      },
    },
  };
  try {
    const response = await fixture.send();
    expect(response).toHaveBeenCalledWith(
      false,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(response.mock.calls.some(([ok]) => ok)).toBe(false);
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(loadSessionEntry(fixture.scope)).toMatchObject({
      status: "interrupted",
      abortedLastRun: false,
      foregroundRun: { runId: fixture.params.idempotencyKey },
      restartRecoveryTerminalRunIds: [fixture.params.idempotencyKey],
    });
    expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    const events = loadTranscriptEventsSync(fixture.scope);
    expect(events).toHaveLength(fixture.activeTranscript.length + 1);
    expect(JSON.stringify(events.at(-1))).toContain("was interrupted");
    expect(JSON.stringify(events.at(-1))).not.toContain("gateway restarted");
    expect(fixture.context.chatAbortControllers.size).toBe(0);
    expect(fixture.context.chatQueuedTurns.size).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});
