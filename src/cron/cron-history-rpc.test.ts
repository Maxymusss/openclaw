import { beforeEach, expect, it, vi } from "vitest";
import { createDirectChatContext } from "../gateway/server-chat.agent-events.test-helpers.js";
import { handleCronHistoryRequest } from "../gateway/server-methods/cron-history.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "../gateway/server-methods/types.js";
import { cronRunLogEntryToDetail } from "./run-history-detail.js";
import { CronService } from "./service.js";
import type { CronRunRecord } from "./store/run-history.types.js";

const mocks = vi.hoisted(() => ({
  records: [] as CronRunRecord[],
  ownerKey: "agent:main:cron:job",
  afterRead: undefined as (() => void) | undefined,
  readChat:
    vi.fn<(opts: GatewayRequestHandlerOptions & { retainedSessionId?: string }) => Promise<void>>(),
}));
vi.mock("./store/read-only.js", () => ({
  readCronRunRecords: async () => structuredClone(mocks.records),
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  resolveTranscriptSessionKeyBySessionId: () => mocks.ownerKey,
}));
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => "/synthetic/sessions.sqlite",
}));
vi.mock("../gateway/server-methods/chat-history-handler.js", () => ({
  handleChatHistoryRequest: mocks.readChat,
}));

function record(id = "one"): CronRunRecord {
  return {
    id,
    jobId: "job",
    runId: "internal-" + id,
    createdAt: 10,
    endedAt: 20,
    status: "succeeded",
    agentId: "main",
    sessionKey: "agent:main:cron:job:run:" + id,
    detail: cronRunLogEntryToDetail(
      {
        jobId: "job",
        ts: 20,
        action: "finished",
        runAtMs: 10,
        runId: id,
        sessionId: "generation-" + id,
        status: "ok",
      },
      { storeKey: "/synthetic/cron" },
    ),
  };
}

beforeEach(() => {
  mocks.records = [record()];
  mocks.ownerKey = "agent:main:cron:job";
  mocks.afterRead = undefined;
  mocks.readChat.mockReset().mockImplementation(async (opts) => {
    mocks.afterRead?.();
    opts.respond(true, {
      messages: [{ role: "assistant", content: "recorded" }],
      hasMore: true,
      nextOffset: 1,
    });
  });
});

async function history(params: Record<string, unknown>, assertAllowed: () => void = () => {}) {
  const respond = vi.fn<RespondFn>();
  const cron = new CronService({
    storePath: "/synthetic/cron",
    cronEnabled: false,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
  vi.spyOn(cron, "readJob").mockResolvedValue(undefined);
  await handleCronHistoryRequest(
    {
      req: { type: "req", id: "history", method: "cron.history", params },
      params,
      client: null,
      respond,
      context: createDirectChatContext({ cronStorePath: "/synthetic/cron", cron }),
      isWebchatConnect: () => false,
    },
    assertAllowed,
  );
  return respond;
}

it("reads only the recorded transcript generation and binds paging to the exact run", async () => {
  const respond = await history({ id: "job", runId: "one" });
  expect(mocks.readChat).toHaveBeenCalledWith(
    expect.objectContaining({
      retainedSessionId: "generation-one",
      params: expect.objectContaining({ sessionKey: "agent:main:cron:job", limit: 100, offset: 0 }),
    }),
  );
  const result = respond.mock.calls[0]?.[1] as { nextCursor: string };
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  await history({ id: "job", runId: "one", cursor: result.nextCursor });
  expect(mocks.readChat).toHaveBeenLastCalledWith(
    expect.objectContaining({ params: expect.objectContaining({ offset: 1 }) }),
  );
  mocks.records = [record("two")];
  const swapped = await history({ id: "job", runId: "two", cursor: result.nextCursor });
  expect(swapped.mock.calls[0]?.[0]).toBe(false);
});

it("refuses an ambiguous timestamp and client-selected session identity", async () => {
  mocks.records.push(record("two"));
  expect((await history({ id: "job", runAtMs: 10 })).mock.calls[0]?.[0]).toBe(false);
  expect(
    (await history({ id: "job", runId: "one", sessionKey: "agent:main:private" })).mock
      .calls[0]?.[0],
  ).toBe(false);
  expect(mocks.readChat).not.toHaveBeenCalled();
});

it.each(["sharing", "retention", "generation"])(
  "rechecks %s after the transcript read before publishing",
  async (change) => {
    let allowed = true;
    mocks.afterRead = () => {
      if (change === "sharing") {
        allowed = false;
      }
      if (change === "retention") {
        mocks.records = [];
      }
      if (change === "generation") {
        mocks.ownerKey = "agent:main:unrelated";
      }
    };
    const respond = await history({ id: "job", runId: "one" }, () => {
      if (!allowed) {
        throw new Error("sharing revoked");
      }
    });
    expect(respond.mock.calls).toHaveLength(1);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
  },
);
