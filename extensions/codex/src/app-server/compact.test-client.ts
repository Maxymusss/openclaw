import { vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexServerNotification } from "./protocol.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

export function createCompactTestClient(
  agentDir: string,
  options: {
    autoCompleteCompaction?: boolean;
    interruptError?: Error;
    rejectInterrupt?: boolean;
    retainedThreadId?: string | null;
    subscribedThreadIds?: readonly string[];
  } = {},
) {
  const handlers = new Set<(notification: CodexServerNotification) => void>();
  const closeHandlers = new Set<() => void>();
  const retainedThreadId =
    options.retainedThreadId === undefined ? "thread-1" : options.retainedThreadId;
  const subscribedThreadIds = new Set(
    options.subscribedThreadIds ?? (retainedThreadId ? [retainedThreadId] : []),
  );
  const emit = (notification: CodexServerNotification): void => {
    // SAFETY: protocol notifications are constructed by this fixture with optional threadId.
    const threadId = (notification.params as { threadId?: string } | undefined)?.threadId;
    if (threadId && !subscribedThreadIds.has(threadId)) {
      return;
    }
    for (const handler of handlers) {
      handler(notification);
    }
  };
  const completeCompaction = (): void => {
    emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-1", threadId: "thread-1", status: "inProgress" },
      },
    });
    emit({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "compact-turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "compact-turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-1", status: "completed", items: [] },
      },
    });
  };
  const request = vi.fn<CodexAppServerClient["request"]>(
    async (method: string, params?: unknown) => {
      // SAFETY: the fixture only reads the common optional threadId from request payloads.
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      if (method === "thread/resume" && threadId) {
        subscribedThreadIds.add(threadId);
        return {
          thread: {
            id: threadId,
            sessionId: "session-1",
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1,
            updatedAt: 1,
            status: { type: "idle" },
            path: null,
            cwd: agentDir,
            projectId: null,
            cliVersion: CODEX_APP_SERVER_VERSION,
            source: "unknown",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.5-codex",
          modelProvider: "openai",
          serviceTier: null,
          cwd: agentDir,
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "dangerFullAccess" },
          permissionProfile: null,
          reasoningEffort: null,
        };
      }
      if (method === "thread/unsubscribe" && threadId) {
        subscribedThreadIds.delete(threadId);
        return {};
      }
      if (method === "turn/interrupt" && options.interruptError) {
        throw options.interruptError;
      }
      if (method === "turn/interrupt" && options.rejectInterrupt) {
        throw new Error("interrupt unavailable");
      }
      if (method === "thread/compact/start" && options.autoCompleteCompaction !== false) {
        if (typeof threadId !== "string") {
          throw new Error("thread/compact/start requires threadId");
        }
        // Codex may emit item notifications before acknowledging the start RPC.
        emit({
          method: "turn/started",
          params: {
            threadId,
            turn: { id: "compact-turn-1", threadId, status: "inProgress" },
          },
        });
        emit({
          method: "item/started",
          params: {
            threadId,
            turnId: "compact-turn-1",
            item: { id: "compact-item-1", type: "contextCompaction" },
          },
        });
        emit({
          method: "item/completed",
          params: {
            threadId,
            turnId: "compact-turn-1",
            item: { id: "compact-item-1", type: "contextCompaction" },
          },
        });
        emit({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: "compact-turn-1", status: "completed", items: [] },
          },
        });
      }
      return {};
    },
  );
  const { client } = createClientHarness();
  const closeTransport = client.close.bind(client);
  const close = vi.fn(() => {
    closeTransport();
    for (const handler of closeHandlers) {
      handler();
    }
  });
  const closeAndWait = vi.fn<CodexAppServerClient["closeAndWait"]>(async () => {
    close();
    return { exited: true, cleanup: "closed" };
  });
  const addNotificationHandler = vi.fn(
    (handler: (notification: CodexServerNotification) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  );
  Object.assign(client, {
    request,
    close,
    closeAndWait,
    addNotificationHandler,
    addRequestHandler: vi.fn(() => () => undefined),
    addCloseHandler: vi.fn((handler: () => void) => {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    }),
  });
  ensureCodexAppServerClientRuntime(client, { agentDir });
  addNotificationHandler.mockClear();
  if (retainedThreadId) {
    void retainCodexAppServerLiveThread(
      client,
      retainedThreadId,
      undefined,
      `config-${retainedThreadId}`,
    );
  }
  return {
    client,
    request,
    close,
    closeAndWait,
    emit,
    completeCompaction,
  };
}
