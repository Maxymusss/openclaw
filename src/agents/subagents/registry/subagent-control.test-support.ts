/** Real registry/SQLite lifetime shared by cancellation ownership regressions. */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../config/config.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";

export function useSubagentControlFixture() {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
  let stateDir = "";
  const persist = vi.fn(persistSubagentRunsToDiskOrThrow);
  const gateway = vi.fn(async (request: { method: string }) => {
    if (request.method !== "agent.wait") {
      throw new Error(`Unexpected registry RPC ${request.method}`);
    }
    return await new Promise<never>(() => {});
  });
  beforeEach(async () => {
    stateDir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "openclaw-ancestor-retirement-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace: stateDir } } }),
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    resetSubagentRegistryForTests({ persist: false });
    gateway.mockReset();
    persist.mockReset().mockImplementation(persistSubagentRunsToDiskOrThrow);
    testing.setDepsForTest({
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      resolveContextEngine: async () => new LegacyContextEngine(),
      callGateway: gateway,
      persistSubagentRunsToDiskOrThrow: persist,
      // Control fixtures inject their transaction faults through one persistence owner.
      persistSubagentRunsToDiskAsyncOrThrow: async (runs, ids, options) => {
        const snapshot = structuredClone(runs);
        await Promise.resolve();
        let committed = false;
        try {
          options.assertCurrent?.();
          persist(snapshot, ids);
          committed = true;
          options.onCommitted?.();
        } catch (error) {
          throw new SubagentRegistryWriteError(committed ? "committed" : "not-committed", error);
        }
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    schedulerTesting.reset();
    await cleanupSessionStateForTest({ stateDir });
    testing.setDepsForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await flushLogger();
    resetLogger();
    await rm(stateDir, { recursive: true, force: true });
    env.restore();
  });

  return {
    get stateDir() {
      return stateDir;
    },
    persist,
    gateway,
  };
}
