import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getProcessSupervisor } from "../../../process/supervisor/index.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../admitted-run-context.js";
import * as codingTools from "../../agent-tools.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import { AuthStorage, ModelRegistry } from "../../sessions/index.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function prepare(foreground = true) {
  const runId = "foreground-generation";
  const authority = foreground
    ? createAdmittedRunOperatorAuthority({
        profileId: "person",
        scopes: ["operator.sessions.write"],
        executionPolicy: "foreground-only",
        foregroundRunId: runId,
        foregroundDeadlineAt: Date.now() + 60_000,
        assertCurrent() {},
      })
    : undefined;
  const admission = prepareSystemAgentRunAdmission(
    {},
    runId,
    "main",
    "tool-generation-test",
    undefined,
    authority,
  );
  const authStorage = AuthStorage.inMemory();
  const attempt: EmbeddedRunAttemptParams = {
    runId,
    sessionId: "generation-session",
    sessionKey: "agent:main:generation-session",
    workspaceDir: "/tmp/workspace",
    sessionFile: "/tmp/workspace/session.jsonl",
    prompt: "run a foreground command",
    timeoutMs: 60_000,
    config: {},
    provider: "test",
    modelId: "test-model",
    thinkLevel: "off",
    model: {
      id: "test-model",
      name: "Test model",
      provider: "test",
      api: "openai-completions",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 1000,
    },
    authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: ModelRegistry.inMemory(authStorage),
    toolsAllow: ["exec", "process"],
    codeModeOverride: false,
    disableToolSearch: true,
    execOverrides: { host: "gateway", mode: "full", ask: "off" },
    admittedRunContext: await admission.admit("embedded"),
  };
  const runAbortController = new AbortController();
  try {
    const tools = await prepareEmbeddedAttemptToolBase({
      agentDir: "/tmp/foreground-agent",
      attempt,
      setup: createAttemptSetupFixture(),
      markCoreToolStage() {},
      onYield() {},
      runAbortController,
      runTrace: { traceId: "11111111111111111111111111111111" },
      skillUsagePaths: undefined,
      skillsSnapshot: undefined,
      codeModeSkills: [],
      toolSearchCatalogExecutor: async () => {
        throw new Error("unexpected catalog execution");
      },
    });
    return { tools, authority, admission, runAbortController };
  } catch (error) {
    admission.close();
    throw error;
  }
}

it("aborts before permission revocation and waits for exact generation cleanup before replacement", async () => {
  const retired = createDeferred();
  const cleanup = vi.fn(() => retired.promise);
  const acquire = vi.spyOn(getProcessSupervisor(), "acquireScopeCleanup").mockReturnValue(cleanup);
  const factory = vi
    .spyOn(codingTools, "createOpenClawCodingToolsInternal")
    .mockImplementation(() => {
      expect(acquire).toHaveBeenCalledTimes(factory.mock.calls.length);
      return [];
    });
  const owner = await prepare();
  const initialSignal = owner.tools.toolAbortSignal;
  const revoke = vi.fn(() => expect(initialSignal.aborted).toBe(true));
  const refresh = owner.tools.refreshPermissionMode("full", revoke);
  try {
    expect(refresh).toBeInstanceOf(Promise);
    expect(revoke).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    retired.resolve();
    await refresh;
    expect(factory).toHaveBeenCalledTimes(2);
    const first = factory.mock.calls[0];
    const second = factory.mock.calls[1];
    expect(first?.[0]?.exec).toMatchObject({
      allowBackground: false,
      scopeKey: acquire.mock.calls[0]?.[0],
    });
    expect(second?.[0]?.exec).toMatchObject({
      allowBackground: false,
      scopeKey: acquire.mock.calls[1]?.[0],
    });
    expect(first?.[0]?.exec?.scopeKey).not.toBe(second?.[0]?.exec?.scopeKey);
    expect(first?.[0]?.exec?.scopeKey).not.toBe(first?.[0]?.sessionKey);
    expect(first?.[2]).toBe(owner.authority);
    expect(second?.[2]).toBe(owner.authority);
    expect(acquire.mock.calls.map((call) => call[1])).toEqual([
      { processTree: "required-all" },
      { processTree: "required-all" },
    ]);
    expect(owner.tools.toolAbortSignal.aborted).toBe(false);
  } finally {
    retired.resolve();
    await refresh;
    await Promise.all(owner.tools.runCleanups.map((run) => run("cancel")));
    owner.admission.close();
  }
});

it("consumes the original deadline while cleanup waits and never exposes a successor after expiry", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const retired = createDeferred();
  vi.spyOn(getProcessSupervisor(), "acquireScopeCleanup").mockReturnValue(() => retired.promise);
  const factory = vi.spyOn(codingTools, "createOpenClawCodingToolsInternal").mockReturnValue([]);
  const owner = await prepare();
  const refresh = owner.tools.refreshPermissionMode("full", () => {});
  const observed = Promise.resolve(refresh).catch((error: unknown) => error);
  try {
    vi.setSystemTime(Date.now() + 60_001);
    retired.resolve();
    expect(await observed).toEqual(
      expect.objectContaining({
        message: "The foreground turn deadline has expired. Start a new request.",
      }),
    );
    expect(factory).toHaveBeenCalledOnce();
  } finally {
    retired.resolve();
    await observed;
    await Promise.all(owner.tools.runCleanups.map((run) => run("cancel")));
    owner.admission.close();
  }
});

it("records uncertain cleanup and refuses permission replacement while staff refresh stays synchronous", async () => {
  const failure = new Error("descendant extinction unconfirmed");
  const acquire = vi
    .spyOn(getProcessSupervisor(), "acquireScopeCleanup")
    .mockReturnValue(async () => {
      throw failure;
    });
  const factory = vi.spyOn(codingTools, "createOpenClawCodingToolsInternal").mockReturnValue([]);
  const receipt = createAgentCleanupScope();
  const owner = await prepare();
  try {
    await expect(
      receipt.run(async () => {
        await owner.tools.refreshPermissionMode("full", () => {});
      }),
    ).rejects.toBe(failure);
    expect(receipt.outcome).toBe("uncertain");
    expect(factory).toHaveBeenCalledOnce();
  } finally {
    await receipt.run(async () => {
      await Promise.all(owner.tools.runCleanups.map((run) => run("cancel")));
    });
    owner.admission.close();
  }
  acquire.mockClear();
  factory.mockClear();
  const staff = await prepare(false);
  try {
    expect(staff.tools.refreshPermissionMode("full", () => {})).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(factory.mock.calls[1]?.[0]?.exec?.scopeKey).toBeUndefined();
  } finally {
    await Promise.all(staff.tools.runCleanups.map((run) => run("cancel")));
    staff.admission.close();
  }
});
