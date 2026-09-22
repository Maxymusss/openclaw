// Minimal Codex app-server fixture for the QA auth product proof.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  createFakeInitializeResponse,
  createFakeThreadStartResponse,
  runFakeCodexAppServer,
} from "../../../../scripts/e2e/lib/codex-app-server-fixture.mjs";

const requestLog = process.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG;
if (!requestLog) {
  throw new Error("missing OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG");
}
const appServerVersion = process.env.OPENCLAW_QA_CODEX_APP_SERVER_VERSION;
if (!appServerVersion) {
  throw new Error("missing OPENCLAW_QA_CODEX_APP_SERVER_VERSION");
}

const fixtureInstanceId = randomUUID();
let fixtureSequence = 0;
let activeAccount = null;
let rpcObservationSequence = 0;
const observeRpc =
  process.env.OPENCLAW_DIAGNOSTICS?.split(/[,\s]+/u).includes("codex.model-catalog");

function recordRpcObservation(method, direction, id) {
  if (!observeRpc) {
    return;
  }
  try {
    const sequence = ++rpcObservationSequence;
    if (sequence > 257) {
      return;
    }
    fs.appendFileSync(
      `${requestLog}.diagnostic.jsonl`,
      `${JSON.stringify({
        fixtureRpcObservation: {
          instanceId: fixtureInstanceId,
          pid: process.pid,
          sequence,
          at: Date.now(),
          method: sequence === 257 ? null : method.slice(0, 96),
          direction: sequence === 257 ? "producer-cap-reached" : direction,
          rpcId:
            sequence === 257
              ? null
              : typeof id === "number" && Number.isFinite(id)
                ? id
                : typeof id === "string"
                  ? id.slice(0, 64)
                  : null,
        },
      })}\n`,
    );
  } catch {
    // Diagnostics neither change the RPC response nor mask the fixture's original error.
  }
}

function observeHandlers(handlers) {
  if (!observeRpc) {
    return handlers;
  }
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      (context) => {
        recordRpcObservation(method, "request", context.id);
        return handler({
          ...context,
          sendResult(result) {
            recordRpcObservation(method, "response", context.id);
            return context.sendResult(result);
          },
          notify(notificationMethod, params) {
            recordRpcObservation(notificationMethod, "notification", null);
            return context.notify(notificationMethod, params);
          },
        });
      },
    ]),
  );
}

function recordAuthOperation(operation, { threadId, turnId } = {}, account = activeAccount) {
  fs.appendFileSync(
    requestLog,
    `${JSON.stringify({
      fixtureAuthOperation: {
        version: 1,
        instanceId: fixtureInstanceId,
        sequence: ++fixtureSequence,
        operation,
        account: account ? { ...account } : null,
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
      },
    })}\n`,
  );
}

const threads = new Map();
const threadResponse = (params, threadId, sessionId) =>
  createFakeThreadStartResponse({
    params,
    threadId,
    sessionId,
    version: appServerVersion,
  });

function restoreThread(threadId) {
  try {
    // Account changes start another app-server process. Recover from self-identifying
    // responses, not JSON-RPC ids, which are reused by clients sharing this log.
    const records = fs.readFileSync(requestLog, "utf8").trim().split("\n").map(JSON.parse);
    const response = records.find(
      (record) => record.result?.thread?.id === threadId && record.result?.model,
    )?.result;
    const thread = response?.thread;
    if (
      !thread ||
      thread.ephemeral !== false ||
      typeof thread.sessionId !== "string" ||
      typeof thread.cwd !== "string" ||
      !Number.isFinite(thread.createdAt) ||
      !Array.isArray(thread.turns)
    ) {
      throw new Error("missing durable thread metadata");
    }
    const turns = new Map(thread.turns.map((turn) => [turn.id, turn]));
    for (const record of records) {
      if (record.method === "turn/completed" && record.params?.threadId === threadId) {
        const turn = record.params.turn;
        if (
          !turn?.id ||
          turn.status !== "completed" ||
          !Array.isArray(turn.items) ||
          turns.has(turn.id)
        ) {
          throw new Error("invalid completed turn history");
        }
        turns.set(turn.id, turn);
      }
    }
    thread.turns = [...turns.values()];
    thread.status = { type: "notLoaded" };
    const state = { response, loaded: false, subscribed: false };
    threads.set(threadId, state);
    return state;
  } catch (cause) {
    throw new Error(`Cannot restore synthetic Codex thread ${threadId}`, { cause });
  }
}

const getThread = (threadId) => threads.get(threadId) ?? restoreThread(threadId);

runFakeCodexAppServer({
  requestLog,
  logMode: "messages",
  handlers: observeHandlers({
    initialize: ({ sendResult }) =>
      sendResult(
        createFakeInitializeResponse({
          name: "openclaw-qa-codex-auth",
          version: appServerVersion,
          userAgent: `openclaw/${appServerVersion} (test)`,
        }),
      ),
    "account/login/start": ({ params, sendResult }) => {
      if (
        params?.type === "chatgptAuthTokens" &&
        typeof params.accessToken === "string" &&
        params.accessToken.trim() &&
        typeof params.chatgptAccountId === "string" &&
        params.chatgptAccountId.trim()
      ) {
        activeAccount = Object.freeze({
          type: "chatgptAuthTokens",
          accountId: params.chatgptAccountId,
        });
      } else if (
        params?.type === "apiKey" &&
        typeof params.apiKey === "string" &&
        params.apiKey.trim()
      ) {
        activeAccount = Object.freeze({ type: "apiKey" });
      } else {
        throw new Error("Synthetic auth fixture requires supported nonempty login credentials");
      }
      recordAuthOperation("auth_applied");
      sendResult({ type: params.type });
    },
    "account/logout": ({ sendResult }) => {
      activeAccount = null;
      recordAuthOperation("auth_cleared");
      sendResult({});
    },
    "model/list": ({ sendResult }) =>
      sendResult({
        data: ["gpt-5.6-luna"].map((model) => ({
          id: model,
          model,
          displayName: model,
          description: "Synthetic auth product proof model",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
          multiAgentVersion: "v2",
          inputModalities: ["text"],
        })),
        nextCursor: null,
      }),
    "account/rateLimits/read": ({ sendResult }) =>
      sendResult({
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: "pro",
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      }),
    "account/read": ({ sendResult }) =>
      sendResult({
        account:
          activeAccount?.type === "chatgptAuthTokens"
            ? { type: "chatgpt", email: "qa-codex-account@example.com", planType: "pro" }
            : activeAccount?.type === "apiKey"
              ? { type: "apiKey" }
              : null,
        requiresOpenaiAuth: true,
      }),
    "thread/start": ({ params, sendResult }) => {
      const response = threadResponse(params, `thread-${randomUUID()}`, `session-${randomUUID()}`);
      response.thread.ephemeral = params?.ephemeral === true;
      threads.set(response.thread.id, { response, loaded: true, subscribed: true });
      recordAuthOperation("thread_started", { threadId: response.thread.id });
      sendResult(response);
    },
    "thread/read": ({ params, sendResult }) => {
      const { thread } = getThread(params?.threadId).response;
      sendResult({ thread: { ...thread, turns: params?.includeTurns ? thread.turns : [] } });
    },
    "thread/unsubscribe": ({ params, sendResult }) => {
      const state = threads.get(params?.threadId);
      const status = !state?.loaded
        ? "notLoaded"
        : state.subscribed
          ? "unsubscribed"
          : "notSubscribed";
      if (state) {
        state.subscribed = false;
      }
      sendResult({ status });
    },
    "thread/resume": ({ notify, params, sendResult }) => {
      const state = getThread(params?.threadId);
      const thread = state.response.thread;
      if (params?.cwd !== undefined && params.cwd !== thread.cwd) {
        throw new Error("Synthetic auth fixture cannot move a resumed thread's workspace");
      }
      // Native full-config adoption reloads only an idle thread with no subscribers.
      // Unsubscribe alone retains the loaded thread and must not fabricate teardown.
      const overrides =
        ["config", "baseInstructions", "developerInstructions"].some(
          (key) => params?.[key] !== undefined,
        ) ||
        ["model", "approvalPolicy", "approvalsReviewer"].some(
          (key) => params?.[key] !== undefined && params[key] !== state.response[key],
        );
      if (state.loaded && overrides && !state.subscribed && thread.status.type === "idle") {
        state.loaded = false;
        thread.status = { type: "notLoaded" };
        notify("thread/status/changed", { threadId: thread.id, status: thread.status });
      }
      if (!state.loaded) {
        state.response = threadResponse(
          { ...params, cwd: thread.cwd },
          thread.id,
          thread.sessionId,
        );
        state.response.thread = { ...thread, status: { type: "idle" } };
        state.loaded = true;
      }
      state.subscribed = true;
      recordAuthOperation("thread_resumed", { threadId: thread.id });
      sendResult(state.response);
    },
    "turn/start": ({ notify, params, sendResult }) => {
      const state = getThread(params?.threadId);
      const thread = state.response.thread;
      if (!state.loaded || thread.status.type !== "idle") {
        throw new Error("Synthetic auth fixture requires an idle loaded thread before a turn");
      }
      const threadId = thread.id;
      const turnId = `turn-${randomUUID()}`;
      const turnAccount = activeAccount ? Object.freeze({ ...activeAccount }) : null;
      recordAuthOperation("turn_started", { threadId, turnId }, turnAccount);
      thread.status = { type: "active", activeFlags: [] };
      const message = {
        type: "agentMessage",
        id: `message-${turnId}`,
        text: "QA_CODEX_AUTH_PRODUCT_PROOF_OK",
      };
      sendResult({
        turn: {
          id: turnId,
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      setImmediate(() => {
        const completedAtMs = Date.now();
        notify("item/completed", {
          item: message,
          threadId,
          turnId,
          completedAtMs,
        });
        const turn = {
          id: turnId,
          items: [message],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: Math.floor(completedAtMs / 1000),
          completedAt: Math.floor(completedAtMs / 1000),
          durationMs: 0,
        };
        thread.turns.push(turn);
        thread.status = { type: "idle" };
        recordAuthOperation("turn_completed", { threadId, turnId }, turnAccount);
        notify("turn/completed", { threadId, turn });
      });
    },
  }),
});
