import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeThreadStartResponse } from "../../scripts/e2e/lib/codex-app-server-fixture.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("createFakeThreadStartResponse", () => {
  it.each([
    { expected: null, params: {} },
    { expected: "project-1", params: { projectId: "project-1" } },
  ])("returns the protocol-required projectId as $expected", ({ expected, params }) => {
    const response = createFakeThreadStartResponse({
      params,
      sessionId: "session-1",
      threadId: "thread-1",
      version: "0.149.1",
    });

    expect(response.thread.projectId).toBe(expected);
  });
});

type AuthFixtureThread = {
  id: string;
  cwd: string;
  ephemeral: boolean;
  createdAt: number;
  status: { type: string };
  turns: Array<{ id: string; items: unknown[] }>;
};

type AuthFixtureMessage = {
  id?: number;
  method?: string;
  result?: { thread?: AuthFixtureThread; status?: string; model?: string };
  params?: {
    threadId?: string;
    status?: { type: string };
    turn?: { id: string; items: unknown[] };
  };
};

function runAuthFixture(requestLog: string, requests: Array<Record<string, unknown>>) {
  const child = spawnSync(
    process.execPath,
    ["test/e2e/qa-lab/runtime/codex-auth-app-server.fixture.mjs"],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        OPENCLAW_QA_CODEX_APP_SERVER_VERSION: "0.154.0",
        OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG: requestLog,
      },
      input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  const messages: AuthFixtureMessage[] = child.stdout.trim()
    ? child.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { ...child, messages };
}

function seedAuthFixture() {
  const workspace = tempDirs.make("codex-fixture-thread-");
  const requestLog = path.join(workspace, "requests.jsonl");
  const started = runAuthFixture(requestLog, [
    { id: 1, method: "thread/start", params: { cwd: workspace } },
    { id: 2, method: "thread/start", params: { cwd: workspace, ephemeral: true } },
  ]);
  expect(started.status, started.stderr).toBe(0);
  const durable = started.messages.find((message) => message.id === 1)?.result?.thread;
  const ephemeral = started.messages.find((message) => message.id === 2)?.result?.thread;
  expect(durable).toBeDefined();
  expect(ephemeral).toBeDefined();
  return { requestLog, workspace, durable: durable!, ephemeral: ephemeral! };
}

describe("auth fixture thread lifecycle", () => {
  it("gives durable and ephemeral starts distinct identities", () => {
    const { durable, ephemeral } = seedAuthFixture();
    expect(durable.id).not.toBe(ephemeral.id);
    expect(durable.ephemeral).toBe(false);
    expect(ephemeral.ephemeral).toBe(true);
  });

  it("restores a cold durable thread and keeps completed turns distinct across processes", () => {
    const { requestLog, workspace, durable } = seedAuthFixture();
    const firstTurn = runAuthFixture(requestLog, [
      { id: 1, method: "thread/resume", params: { threadId: durable.id, cwd: workspace } },
      { id: 2, method: "turn/start", params: { threadId: durable.id } },
    ]);
    expect(firstTurn.status, firstTurn.stderr).toBe(0);
    const completed = firstTurn.messages.find((message) => message.method === "turn/completed")
      ?.params?.turn;
    expect(completed).toBeDefined();
    const secondTurn = runAuthFixture(requestLog, [
      { id: 1, method: "thread/read", params: { threadId: durable.id, includeTurns: true } },
      { id: 2, method: "thread/read", params: { threadId: durable.id, includeTurns: false } },
      { id: 3, method: "thread/resume", params: { threadId: durable.id, cwd: workspace } },
      { id: 4, method: "turn/start", params: { threadId: durable.id } },
    ]);
    expect(secondTurn.status, secondTurn.stderr).toBe(0);
    expect(secondTurn.messages.find((message) => message.id === 1)?.result?.thread).toMatchObject({
      id: durable.id,
      cwd: workspace,
      createdAt: durable.createdAt,
      ephemeral: false,
      status: { type: "notLoaded" },
      turns: [completed],
    });
    expect(secondTurn.messages.find((message) => message.id === 2)?.result?.thread?.turns).toEqual(
      [],
    );
    expect(secondTurn.messages.find((message) => message.id === 3)?.result?.thread).toMatchObject({
      id: durable.id,
      cwd: workspace,
      status: { type: "idle" },
      turns: [completed],
    });
    const next = secondTurn.messages.find((message) => message.method === "turn/completed")?.params
      ?.turn;
    expect(next).toBeDefined();
    expect(next?.id).not.toBe(completed?.id);
    const read = runAuthFixture(requestLog, [
      { id: 1, method: "thread/read", params: { threadId: durable.id, includeTurns: true } },
    ]);
    expect(read.status, read.stderr).toBe(0);
    expect(read.messages[0]?.result?.thread?.turns).toEqual([completed, next]);
  });

  it.each(["unknown", "ephemeral", "corrupt"])("rejects %s cold thread recovery", (kind) => {
    const { requestLog, durable, ephemeral } = seedAuthFixture();
    if (kind === "corrupt") {
      fs.appendFileSync(requestLog, "{\n");
    }
    const threadId =
      kind === "unknown" ? "unknown-thread" : kind === "ephemeral" ? ephemeral.id : durable.id;
    const read = runAuthFixture(requestLog, [
      { id: 1, method: "thread/read", params: { threadId, includeTurns: false } },
    ]);
    expect(read.status, read.stderr).toBe(1);
    expect(read.stderr).toContain("Cannot restore synthetic Codex thread");
  });

  it("retains an unsubscribed loaded thread until full-config resume actually reloads it", () => {
    const { requestLog, durable, workspace } = seedAuthFixture();
    const run = runAuthFixture(requestLog, [
      { id: 1, method: "thread/resume", params: { threadId: durable.id, cwd: workspace } },
      { id: 2, method: "thread/unsubscribe", params: { threadId: durable.id } },
      { id: 3, method: "thread/read", params: { threadId: durable.id } },
      { id: 4, method: "thread/unsubscribe", params: { threadId: durable.id } },
      {
        id: 5,
        method: "thread/resume",
        params: { threadId: durable.id, cwd: workspace, config: {} },
      },
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.messages.find((message) => message.id === 2)?.result).toEqual({
      status: "unsubscribed",
    });
    expect(run.messages.find((message) => message.id === 3)?.result?.thread?.status).toEqual({
      type: "idle",
    });
    expect(run.messages.find((message) => message.id === 4)?.result).toEqual({
      status: "notSubscribed",
    });
    const unloaded = run.messages.findIndex(
      (message) =>
        message.method === "thread/status/changed" && message.params?.status?.type === "notLoaded",
    );
    expect(unloaded).toBeGreaterThan(run.messages.findIndex((message) => message.id === 4));
    expect(unloaded).toBeLessThan(run.messages.findIndex((message) => message.id === 5));
  });

  it.each([false, true])(
    "does not invent an unload for a subscribed thread (active=%s)",
    (active) => {
      const { requestLog, durable, workspace } = seedAuthFixture();
      const run = runAuthFixture(requestLog, [
        { id: 1, method: "thread/resume", params: { threadId: durable.id, cwd: workspace } },
        ...(active ? [{ id: 2, method: "turn/start", params: { threadId: durable.id } }] : []),
        {
          id: 3,
          method: "thread/resume",
          params: { threadId: durable.id, model: "ignored-model", config: {} },
        },
      ]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.messages.find((message) => message.id === 3)?.result?.model).toBe("gpt-5.6-luna");
      expect(run.messages.find((message) => message.id === 3)?.result?.thread?.status.type).toBe(
        active ? "active" : "idle",
      );
      if (active) {
        expect(
          run.messages.findIndex((message) => message.method === "turn/completed"),
        ).toBeGreaterThan(run.messages.findIndex((message) => message.id === 3));
      }
      expect(
        run.messages.filter(
          (message) =>
            message.method === "thread/status/changed" &&
            message.params?.status?.type === "notLoaded",
        ),
      ).toEqual([]);
    },
  );
});

describe("fake Codex configuration preflight", () => {
  it.each([
    ["auth", "test/e2e/qa-lab/runtime/codex-auth-app-server.fixture.mjs"],
    ["approval", "test/e2e/qa-lab/runtime/codex-native-approval-app-server.fixture.mjs"],
    ["media", "scripts/e2e/lib/codex-media-path/fake-codex-app-server.mjs"],
  ])("%s exposes empty effective config and no managed requirements", (_name, fixture) => {
    const requestLog = path.join(tempDirs.make("codex-fixture-config-"), "requests.jsonl");
    const result = spawnSync(process.execPath, [fixture], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_QA_CODEX_APP_SERVER_VERSION: "0.153.0",
        OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG: requestLog,
        OPENCLAW_QA_CODEX_NATIVE_APPROVAL_LOG: requestLog,
        OPENCLAW_CODEX_MEDIA_PATH_APP_SERVER_LOG: requestLog,
      },
      input:
        [
          { id: 1, method: "config/read", params: { cwd: process.cwd(), includeLayers: true } },
          { id: 2, method: "configRequirements/read" },
        ]
          .map((request) => JSON.stringify(request))
          .join("\n") + "\n",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { id: 1, result: { config: {}, origins: {}, layers: [] } },
      { id: 2, result: { requirements: null } },
    ]);
  });
});
