import path from "node:path";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmittedHostCapabilityTestFixture } from "../../src/agents/harness/host-capability.test-support.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AgentsApiConfig } from "./agentsapi-config.js";
import { createAgentsApiHarness } from "./agentsapi-harness.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const cleanups: Array<() => void | Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const responsesKey = "fixture-responses-key";
const agentsApiKey = "fixture-agents-api-key";
const backendMessage = "Fixture session creation rejected";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  fetchWithSsrFGuardMock.mockReset();
  vi.unstubAllEnvs();
});

describe("Agents API configured credentials", () => {
  it.each([
    { name: "dedicated plugin key", pluginConfig: { apiKey: agentsApiKey }, key: agentsApiKey },
    { name: "legacy provider key", pluginConfig: {}, key: responsesKey },
  ])("authenticates the SDK session request with the $name", async ({ pluginConfig, key }) => {
    const { harness, params } = await createFixture(pluginConfig);

    const result = await harness.runAttempt(params);

    expect(result.terminal).toMatchObject({ kind: "failed" });
    if (result.terminal.kind !== "failed") {
      throw new Error("Expected the fixture backend rejection");
    }
    expect(String(result.terminal.error)).toContain(backendMessage);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("Expected an SDK session creation request");
    }
    const request = new Request(call.url, call.init);
    expect(request.url).toBe("https://api.openai.com/v1/agents/sessions");
    expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(await request.json()).toMatchObject({ agent: { model: "fixture-model" } });
  });

  it.each([
    { name: "missing", value: undefined },
    { name: "empty", value: " " },
    { name: "unresolved environment placeholder", value: "${AGENTS_API_KEY}" },
    {
      name: "unresolved SecretRef",
      value: { source: "env", provider: "default", id: "AGENTS_API_KEY" },
    },
  ])(
    "rejects a $name plugin key before falling back to Responses credentials",
    async ({ value }) => {
      const { harness, params } = await createFixture({ apiKey: agentsApiKey });
      params.config = {
        ...params.config,
        plugins: { entries: { agentsapi: { config: { apiKey: value } } } },
      };

      await expect(harness.runAttempt(params)).rejects.toThrow(
        "plugins.entries.agentsapi.config.apiKey",
      );
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    },
  );

  it("accepts the dedicated key independently of a subscription Responses route", async () => {
    const { harness } = await createFixture({ apiKey: agentsApiKey });

    expect(
      harness.supports({
        provider: "openai",
        requestedRuntime: "agentsapi",
        modelProvider: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://responses.example.test/v1",
          requestTransportOverrides: "present",
          preparedAuth: { source: "profile", mode: "oauth", requirement: "subscription" },
        },
      }),
    ).toEqual({ supported: true });
  });
});

async function createFixture(pluginConfig: AgentsApiConfig) {
  const root = tempDirs.make("openclaw-agentsapi-key-");
  cleanups.push(() => {
    resetPluginStateStoreForTests();
  });
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const storePath = path.join(root, "sessions.json");
  const target = {
    agentId: "main",
    sessionId: "session-fixture",
    sessionKey: "agent:main:fixture",
    storePath,
  };
  await upsertSessionEntry({
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    storePath,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const config: OpenClawConfig = {
    session: { store: storePath },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl:
            pluginConfig.apiKey === undefined
              ? "https://api.openai.com/v1"
              : "https://responses.example.test/v1",
          apiKey: responsesKey,
          models: [],
        },
      },
    },
    plugins: { entries: { agentsapi: { config: pluginConfig } } },
  };
  const authStorage = AuthStorage.inMemory();
  const attempt: Omit<AgentHarnessAttemptParamsV2, "hostCapabilities"> = {
    ...target,
    config,
    sessionTarget: target,
    sessionFile: target.sessionKey,
    workspaceDir: root,
    agentDir: root,
    prompt: "Fixture prompt",
    runId: "run-fixture",
    provider: "openai",
    modelId: "fixture-model",
    model: {
      id: "fixture-model",
      name: "Fixture model",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://responses.example.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 1024,
    },
    resolvedApiKey: responsesKey,
    authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: ModelRegistry.inMemory(authStorage),
    thinkLevel: "off",
    timeoutMs: 5000,
  };
  const host = await createAdmittedHostCapabilityTestFixture(attempt);
  cleanups.push(() => {
    host.closeHost();
    host.closeAdmission();
  });
  const runtime = createPluginRuntime();
  runtime.state = {
    ...runtime.state,
    openSyncKeyedStore: <T>(
      options: Parameters<typeof createPluginStateSyncKeyedStoreForTests>[1],
    ) => createPluginStateSyncKeyedStoreForTests<T>("agentsapi", options),
  };
  const harness = createAgentsApiHarness(runtime, pluginConfig);
  cleanups.push(async () => await harness.dispose?.());
  fetchWithSsrFGuardMock.mockImplementation(async (request) => {
    request.beforeRequest?.();
    return {
      response: Response.json({ error: { message: backendMessage } }, { status: 400 }),
      finalUrl: request.url,
      release: async () => {},
    };
  });
  return { harness, params: { ...attempt, hostCapabilities: host.hostCapabilities } };
}
