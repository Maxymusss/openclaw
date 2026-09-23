import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as executablePath from "../../infra/executable-path.js";
import * as privateTemp from "../../infra/private-temp-workspace.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { resolveCommandProcessSignal } from "../../process/exec-spawn.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resetProcessRegistryForTests } from "../bash-process-registry.test-support.js";
import { captureForegroundExecPolicy } from "../bash-tools.exec-foreground.js";
import { runExecProcess } from "../bash-tools.exec-runtime.js";
import { registerSandboxBackend } from "./backend.js";
import type { ReservedSandboxBackendFactoryV1 } from "./backend.types.js";
import {
  bindNativeSandboxEngineTarget,
  captureNativeSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  execNativeSandboxCreate,
  readNativeSandboxExecution,
} from "./container-engine.js";
import {
  replaceNativeSandboxContext,
  resolveSandboxContext,
  resolveSandboxContextInternal,
} from "./context.js";
import {
  commandResult,
  createNativeGeneration,
  createNativePipeline,
  type NativePipelineOptions,
} from "./context.native-custody.test-support.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
import { removeSandboxContainer } from "./manage.js";
import { bindNativeSandboxExecTarget } from "./native-exec-binding.js";
import {
  readRegistry,
  readRegistryEntry,
  reserveSandboxRegistryEntry,
  updateRegistry,
} from "./registry.js";

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: transport.spawn,
}));
vi.mock("../../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: async () => [],
}));
vi.mock("../../skills/runtime/remote.js", () => ({ getRemoteSkillEligibility: () => undefined }));
vi.mock("../exec-defaults.js", () => ({ resolveNodeExecEligibility: () => ({ canExec: false }) }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const releases: Array<() => Promise<void>> = [];
let endpoint: string;
let executable: string;
let stateDir: string;
let workspaceDir: string;
let config: OpenClawConfig;

beforeEach(() => {
  stateDir = tempDirs.make("native-sandbox-custody-");
  workspaceDir = path.join(stateDir, "workspace");
  config = {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "docker",
          scope: "shared",
          workspaceAccess: "rw",
          workspaceRoot: path.join(stateDir, "sandboxes"),
          docker: { image: "fixture:local", setupCommand: "fixture-setup" },
          prune: { idleHours: 0, maxAgeDays: 0 },
        },
      },
    },
  };
  endpoint = `unix://${path.join(stateDir, "engine.sock")}`;
  executable = path.join(stateDir, "bin", "docker");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("DOCKER_HOST", endpoint);
  vi.stubEnv("DOCKER_CONTEXT", "");
  vi.spyOn(executablePath, "resolveExecutableFromPathEnv").mockReturnValue(executable);
  transport.spawn.mockReset().mockResolvedValue(commandResult());
});

afterEach(async () => {
  for (const release of releases.splice(0)) {
    await release();
  }
  resetProcessRegistryForTests();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function generation() {
  return createNativeGeneration(releases);
}

describe("captured native command transport", () => {
  it("copies executable, environment and target arguments without exposing mutable binding state", async () => {
    vi.stubEnv("NATIVE_CUSTODY_FIXTURE", "captured");
    const { custody } = await generation();
    const captured = captureNativeSandboxEngine(DOCKER_SANDBOX_ENGINE, custody);
    const target = { key: "selected-engine", globalArgs: ["--host", endpoint] };
    const bound = bindNativeSandboxEngineTarget(captured, target);
    const selectedEndpoint = endpoint;
    target.globalArgs[1] = "unix:///changed.sock";
    vi.stubEnv("DOCKER_HOST", "unix:///ambient-drift.sock");
    vi.stubEnv("NATIVE_CUSTODY_FIXTURE", "changed");
    const spec = readNativeSandboxExecution(bound);
    if (!spec) {
      throw new Error("missing private execution binding");
    }
    spec.env.NATIVE_CUSTODY_FIXTURE = "mutated-by-consumer";
    await execContainer(bound, ["info"]);
    expect(transport.spawn).toHaveBeenCalledExactlyOnceWith(
      [executable, "--host", selectedEndpoint, "info"],
      expect.objectContaining({
        cwd: process.cwd(),
        baseEnv: expect.objectContaining({
          DOCKER_HOST: selectedEndpoint,
          NATIVE_CUSTODY_FIXTURE: "captured",
        }),
      }),
    );
    expect(readNativeSandboxExecution(bound)?.env.NATIVE_CUSTODY_FIXTURE).toBe("captured");
  });

  it.each([undefined, "cancel", "exit"] as const)(
    "records only a successful immutable create receipt (failure=%s)",
    async (failure) => {
      const { custody } = await generation();
      const bound = bindNativeSandboxEngineTarget(
        captureNativeSandboxEngine(DOCKER_SANDBOX_ENGINE, custody),
        {
          key: "selected-engine",
          globalArgs: ["--host", endpoint],
        },
      );
      const id = "a".repeat(64);
      const receipt = vi.fn();
      transport.spawn.mockResolvedValue(commandResult(id, failure));
      const pending = execNativeSandboxCreate(bound, ["create", "--name", "reserved"], receipt);
      if (failure) {
        await expect(pending).rejects.toThrow();
        expect(receipt).not.toHaveBeenCalled();
      } else {
        await pending;
        expect(receipt).toHaveBeenCalledExactlyOnceWith(id);
      }
    },
  );

  it("retains a successful late receipt while revoked authority blocks the next command", async () => {
    const { custody, source } = await generation();
    const bound = bindNativeSandboxEngineTarget(
      captureNativeSandboxEngine(DOCKER_SANDBOX_ENGINE, custody),
      {
        key: "selected-engine",
        globalArgs: ["--host", endpoint],
      },
    );
    const entered = createDeferred();
    const finish = createDeferred();
    const id = "b".repeat(64);
    transport.spawn.mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
      return commandResult(id);
    });
    const receipt = vi.fn();
    const revoked = new Error("original authority revoked");
    const pending = execNativeSandboxCreate(bound, ["create", "--name", "reserved"], receipt);
    const observed = pending.catch((error: unknown) => error);
    try {
      await entered.promise;
      source.abort(revoked);
      finish.resolve();
      expect(await observed).toBe(revoked);
      expect(receipt).toHaveBeenCalledExactlyOnceWith(id);
      await expect(execContainer(bound, ["start", id])).rejects.toThrow(
        "operator execution authority is no longer active",
      );
      expect(transport.spawn).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      await observed;
    }
  });

  it("does not turn invalid successful output into an allocation receipt", async () => {
    const { custody } = await generation();
    const bound = bindNativeSandboxEngineTarget(
      captureNativeSandboxEngine(DOCKER_SANDBOX_ENGINE, custody),
      {
        key: "selected-engine",
        globalArgs: ["--host", endpoint],
      },
    );
    const receipt = vi.fn();
    transport.spawn.mockResolvedValue(commandResult("short-id"));
    await expect(
      execNativeSandboxCreate(bound, ["create", "--name", "reserved"], receipt),
    ).rejects.toThrow("immutable container ID");
    expect(receipt).not.toHaveBeenCalled();
  });
});

function nativePipeline(options: NativePipelineOptions = {}) {
  return createNativePipeline({ spawn: transport.spawn, stateDir, endpoint }, options);
}

function expectUncertainCleanup(
  owner: Awaited<ReturnType<typeof generation>>["owner"],
  message: string,
) {
  expect(() => owner.assertCleanupConfirmed()).toThrow(
    expect.objectContaining({
      name: "CommandProcessCleanupError",
      cause: expect.objectContaining({ message: expect.stringContaining(message) }),
    }),
  );
}

function resolveNative(custody: Awaited<ReturnType<typeof generation>>["custody"]) {
  return resolveSandboxContextInternal(
    { config, sessionKey: "agent:test:native", workspaceDir },
    custody,
  );
}

describe("actual native resolver custody", () => {
  it.each([false, true])(
    "refuses an existing generation before native allocation (marked=%s)",
    async (marked) => {
      const h = nativePipeline();
      const { owner, custody } = await generation();
      reserveSandboxRegistryEntry({
        containerName: "preexisting-runtime",
        backendId: "docker",
        sessionKey: custody.runtimeKey,
        workspaceDir,
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "fixture:local",
        ...(marked ? { retirementPolicy: "foreground-owner" as const } : {}),
      });
      const before = await readRegistryEntry("preexisting-runtime");
      await expect(resolveNative(custody)).rejects.toThrow(/cannot adopt|custody retained/);
      expect(h.allocations.size).toBe(0);
      expect(
        h.commands.some((args) => ["image", "create", "start", "rm"].includes(args[0] ?? "")),
      ).toBe(false);
      await owner.release("error");
      expect(() => owner.assertCleanupConfirmed()).not.toThrow();
      await expect(readRegistryEntry("preexisting-runtime")).resolves.toEqual(before);
    },
  );

  it("allocates distinct shared-mode runtimes with unchanged workspace and captured transport", async () => {
    const h = nativePipeline();
    const first = await generation();
    const second = await generation();
    const a = await resolveNative(first.custody);
    const b = await resolveNative(second.custody);
    if (!a?.backend || !b?.backend) {
      throw new Error("missing actual sandbox contexts");
    }
    expect(a.runtimeId).not.toBe(b.runtimeId);
    expect(a.workspaceDir).toBe(b.workspaceDir);
    expect(a.agentWorkspaceDir).toBe(workspaceDir);
    expect(b.agentWorkspaceDir).toBe(workspaceDir);
    expect(a.sessionKey).toBe(b.sessionKey);
    const rows = (await readRegistry()).entries;
    expect(rows.map((row) => row.sessionKey).toSorted()).toEqual(
      [first.custody.runtimeKey, second.custody.runtimeKey].toSorted(),
    );
    expect(
      rows.every(
        (row) => row.retirementPolicy === "foreground-owner" && row.runtimeState === "ready",
      ),
    ).toBe(true);
    const allocation = h.allocations.get(a.runtimeId);
    if (!allocation) {
      throw new Error("missing original allocation");
    }
    vi.stubEnv("DOCKER_HOST", "unix:///ambient-drift.sock");
    vi.stubEnv("DOCKER_CONTEXT", "ambient-context");
    const spec = await a.backend.buildExecSpec({ command: "true", env: {}, usePty: false });
    try {
      expect(spec.argv.slice(0, 3)).toEqual([executable, "--host", endpoint]);
      expect(spec.argv).toContain(allocation.id);
      expect(spec.env.DOCKER_HOST).toBe(endpoint);
      spec.env.DOCKER_HOST = "unix:///consumer-mutation.sock";
      await a.backend.runShellCommand({ script: "true" });
      expect(transport.spawn.mock.lastCall?.[0].slice(0, 3)).toEqual([
        executable,
        "--host",
        endpoint,
      ]);
      expect(transport.spawn.mock.lastCall?.[1].baseEnv.DOCKER_HOST).toBe(endpoint);
    } finally {
      await a.backend.finalizeExec?.({
        token: spec.finalizeToken,
        status: "completed",
        exitCode: 0,
        timedOut: false,
      });
    }
    const before = h.commands.length;
    await expect(removeSandboxContainer(a.runtimeId)).rejects.toThrow("custody retained");
    expect(h.commands).toHaveLength(before);
    await first.owner.release("completion");
    await first.owner.release("completion");
    expect(() => first.owner.assertCleanupConfirmed()).not.toThrow();
    expect(h.commands.filter((args) => args[0] === "rm")).toEqual([["rm", allocation.id]]);
    expect(h.allocations.get(b.runtimeId)?.state).toBe("running");
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await expect(readRegistry()).resolves.toEqual({
      entries: rows.filter((row) => row.containerName === b.runtimeId),
    });
  });

  it.each(["create", "start"] as const)(
    "joins a late %s after Stop without setup or handle exposure",
    async (heldCommand) => {
      const entered = createDeferred();
      const finish = createDeferred();
      let dispatchedSignal: AbortSignal | undefined;
      const h = nativePipeline({
        before: async (args) => {
          if (args[0] === heldCommand) {
            dispatchedSignal = resolveCommandProcessSignal();
            entered.resolve();
            await finish.promise;
          }
        },
      });
      const { owner, custody, source } = await generation();
      const pending = resolveNative(custody);
      const failed = expect(pending).rejects.toThrow("native stop");
      let released = false;
      let release: Promise<void> | undefined;
      try {
        await entered.promise;
        const pendingRows = (await readRegistry()).entries;
        expect(pendingRows).toHaveLength(1);
        expect(pendingRows[0]?.retirementPolicy).toBe("foreground-owner");
        source.abort(new Error("native stop"));
        expect(dispatchedSignal).toBeDefined();
        expect(dispatchedSignal?.aborted).toBe(false);
        release = owner.release("abort").then(() => {
          released = true;
        });
        await Promise.resolve();
        expect(released).toBe(false);
        finish.resolve();
        await failed;
        await release;
        expect(() => owner.assertCleanupConfirmed()).not.toThrow();
        expect(h.commands.filter((args) => args[0] === "start")).toHaveLength(
          heldCommand === "start" ? 1 : 0,
        );
        expect(
          h.commands.some((args) => args[0] === "exec" && args.includes("fixture-setup")),
        ).toBe(false);
        expect(h.commands.filter((args) => args[0] === "rm")).toEqual([
          ["rm", "1".padStart(64, "a")],
        ]);
        expect(h.allocations.size).toBe(0);
        await expect(readRegistry()).resolves.toEqual({ entries: [] });
      } finally {
        finish.resolve();
        await Promise.allSettled([pending, release, failed]);
      }
    },
  );

  it.each(["create", "start"] as const)(
    "does not record queued %s as dispatched after Stop",
    async (command) => {
      const h = nativePipeline();
      const { owner, custody, source } = await generation();
      const runProducer = custody.runProducer;
      let enqueued = 0;
      vi.spyOn(custody, "runProducer").mockImplementation((run, options) => {
        const pending = runProducer(run, options);
        if (options?.settleAfterAbort && ++enqueued === (command === "create" ? 1 : 2)) {
          source.abort(new Error("stopped before dispatch"));
        }
        return pending;
      });
      await expect(resolveNative(custody)).rejects.toThrow("stopped before dispatch");
      await owner.release("abort");
      expect(() => owner.assertCleanupConfirmed()).not.toThrow();
      expect(h.commands.filter((args) => args[0] === command)).toEqual([]);
      expect(h.commands.filter((args) => args[0] === "rm")).toEqual(
        command === "start" ? [["rm", "1".padStart(64, "a")]] : [],
      );
      expect(h.commands.some((args) => args[0] === "kill" || args[0] === "wait")).toBe(false);
      await expect(readRegistry()).resolves.toEqual({ entries: [] });
    },
  );

  it("retires the never-started allocation while preserving the real env-file cleanup failure", async () => {
    const h = nativePipeline();
    const cleanupFailure = new Error("env cleanup failed");
    const realWorkspace = privateTemp.tempWorkspace;
    vi.spyOn(privateTemp, "tempWorkspace").mockImplementation(async (options) => {
      const workspace = await realWorkspace(options);
      if (options.prefix !== "openclaw-container-env-") {
        return workspace;
      }
      return {
        ...workspace,
        cleanup: async () => {
          await workspace.cleanup();
          throw cleanupFailure;
        },
      };
    });
    const { owner, custody } = await generation();
    await expect(resolveNative(custody)).rejects.toThrow(cleanupFailure.message);
    expect(h.allocations.size).toBe(1);
    expect(h.commands.some((args) => args.includes("{{json .}}"))).toBe(true);
    expect(h.commands.some((args) => args[0] === "start" || args[0] === "rm")).toBe(false);
    await owner.release("error");
    expect(() => owner.assertCleanupConfirmed()).not.toThrow();
    expect(h.commands.filter((args) => args[0] === "rm")).toEqual([["rm", "1".padStart(64, "a")]]);
    expect(h.commands.some((args) => args[0] === "kill" || args[0] === "wait")).toBe(false);
    await expect(readRegistry()).resolves.toEqual({ entries: [] });
  });

  it.each([
    {
      name: "invalid create ID",
      createOutput: "not-an-immutable-id",
      message: "immutable container ID",
    },
    {
      name: "foreign inspected owner",
      inspectOverride: { Config: { Labels: {} } },
      message: "reserved owner",
    },
  ])(
    "retains unknown allocation for $name with zero start/setup",
    async ({ createOutput, inspectOverride, message }) => {
      const h = nativePipeline({ createOutput, inspectOverride });
      const { owner, custody } = await generation();
      await expect(resolveNative(custody)).rejects.toThrow(message);
      await owner.release("error");
      expectUncertainCleanup(owner, createOutput ? "receipt is missing" : "reserved owner");
      expect(h.commands.some((args) => args[0] === "start" || args[0] === "rm")).toBe(false);
      expect((await readRegistry()).entries).toMatchObject([
        { retirementPolicy: "foreground-owner" },
      ]);
    },
  );

  it("forgets only its exact pre-dispatch reservation after revocation during image inspection", async () => {
    const { owner, custody, source } = await generation();
    const h = nativePipeline({
      before: async (args) => {
        if (args[0] === "image") {
          expect((await readRegistry()).entries).toMatchObject([
            { retirementPolicy: "foreground-owner" },
          ]);
          source.abort(new Error("revoked before create"));
        }
      },
    });
    await expect(resolveNative(custody)).rejects.toThrow("revoked before create");
    await owner.release("error");
    expect(() => owner.assertCleanupConfirmed()).not.toThrow();
    expect(h.commands.some((args) => args[0] === "create" || args[0] === "rm")).toBe(false);
    await expect(readRegistry()).resolves.toEqual({ entries: [] });
  });

  it.each(["browser", "builtin override"] as const)(
    "refuses %s before native allocation",
    async (reason) => {
      const h = nativePipeline();
      const { custody } = await generation();
      const factory = vi.fn(async () => {
        throw new Error("override must not run");
      });
      const restore =
        reason === "builtin override" ? registerSandboxBackend("docker", factory) : undefined;
      if (reason === "browser") {
        config.agents = {
          defaults: { sandbox: { mode: "all", backend: "docker", browser: { enabled: true } } },
        };
      }
      try {
        await expect(resolveNative(custody)).rejects.toThrow(/browser|native builtin/);
        expect(factory).not.toHaveBeenCalled();
        expect(h.commands).toEqual([]);
        await expect(readRegistry()).resolves.toEqual({ entries: [] });
        expect(fs.existsSync(workspaceDir)).toBe(false);
      } finally {
        restore?.();
      }
    },
  );

  it("replaces only the retired generation on its original target and permanently revokes old handles", async () => {
    const h = nativePipeline();
    const { owner, custody } = await generation();
    const initial = await resolveNative(custody);
    if (!initial?.backend) {
      throw new Error("missing initial context");
    }
    const oldSpec = await initial.backend.buildExecSpec({
      command: "true",
      env: {},
      usePty: false,
    });
    await initial.backend.finalizeExec?.({
      token: oldSpec.finalizeToken,
      status: "completed",
      exitCode: 0,
      timedOut: false,
    });
    await owner.retire("permission-change");
    owner.assertCleanupConfirmed();
    const next = owner.replace();
    if (!next.nativeCustody) {
      throw new Error("missing successor custody");
    }
    vi.stubEnv("DOCKER_HOST", "unix:///changed-after-retirement.sock");
    const successor = await replaceNativeSandboxContext(initial, next.nativeCustody);
    expect(successor.runtimeId).not.toBe(initial.runtimeId);
    expect(successor.workspaceDir).toBe(initial.workspaceDir);
    expect(successor.agentWorkspaceDir).toBe(initial.agentWorkspaceDir);
    expect(successor.fsBridge).not.toBe(initial.fsBridge);
    expect(successor.backend).not.toBe(initial.backend);
    await expect(initial.backend.runShellCommand({ script: "true" })).rejects.toThrow();
    await expect(
      initial.backend.buildExecSpec({ command: "true", env: {}, usePty: false }),
    ).rejects.toThrow();
    if (!successor.backend) {
      throw new Error("missing successor backend");
    }
    const spec = await successor.backend.buildExecSpec({ command: "true", env: {}, usePty: false });
    expect(spec.argv.slice(0, 3)).toEqual([executable, "--host", endpoint]);
    expect(spec.argv).toContain(h.allocations.get(successor.runtimeId)?.id);
    expect(spec.argv).not.toContain("1".padStart(64, "a"));
    await successor.backend.finalizeExec?.({
      token: spec.finalizeToken,
      status: "completed",
      exitCode: 0,
      timedOut: false,
    });
    const target = bindNativeSandboxExecTarget(
      {
        containerName: successor.containerName,
        workspaceDir,
        containerWorkdir: "/workspace",
        env: {},
      },
      successor.backend,
    );
    const policy = captureForegroundExecPolicy(owner.operatorAuthority, {
      sandbox: target,
      scopeKey: next.scopeKey,
    });
    expect(() =>
      policy?.assertAllowed({ command: "true" }, "sandbox", {
        sandbox: target,
        scopeKey: next.scopeKey,
      }),
    ).not.toThrow();
    expect(() =>
      policy?.assertAllowed({ command: "true" }, "sandbox", {
        sandbox: target,
        scopeKey: custody.runtimeKey,
      }),
    ).toThrow("different tool generation");
    expect(() =>
      policy?.assertAllowed({ command: "true" }, "sandbox", {
        sandbox: { ...target },
        scopeKey: next.scopeKey,
      }),
    ).toThrow("unavailable");
    await owner.release("completion");
    owner.assertCleanupConfirmed();
    expect(() => policy?.assertCurrent()).toThrow();
    await expect(readRegistry()).resolves.toEqual({ entries: [] });
  });

  it.each([
    { name: "replaced daemon", info: { ID: "other-daemon" }, message: "identity changed" },
    { name: "non-Linux daemon", info: { OSType: "windows" }, message: "Linux Docker" },
    {
      name: "synthetic conmon loss",
      state: { ExitCode: -1, Error: "conmon disappeared" },
      message: "extinction is unconfirmed",
    },
    {
      name: "never-started exit history",
      state: { StartedAt: "0001-01-01T00:00:00Z" },
      message: "extinction is unconfirmed",
    },
    { name: "unconfirmed removal", fail: "rm", message: "command failed" },
    { name: "missing container", fail: "inspect", message: "command failed" },
  ])(
    "retains custody after $name and forbids a successor",
    async ({ info, state, fail, message }) => {
      const options: Parameters<typeof nativePipeline>[0] = {};
      const h = nativePipeline(options);
      const { owner, custody } = await generation();
      const context = await resolveNative(custody);
      if (!context) {
        throw new Error("missing context");
      }
      const before = await readRegistry();
      options.infoOverride = info;
      if (state) {
        options.inspectOverride = {
          State: {
            Status: "exited",
            Running: false,
            Paused: false,
            Restarting: false,
            Dead: false,
            Pid: 0,
            Error: "",
            ExitCode: 137,
            StartedAt: "2026-01-01T00:00:00Z",
            FinishedAt: "2026-01-01T00:00:01Z",
            ...state,
          },
        };
        const allocation = h.allocations.get(context.runtimeId);
        if (!allocation) {
          throw new Error("missing allocation");
        }
        allocation.state = "exited";
      }
      options.fail = (args) => args[0] === fail;
      await owner.release("completion");
      expectUncertainCleanup(owner, message);
      expect(() => owner.replace()).toThrow("confirmed cleanup");
      await expect(readRegistry()).resolves.toEqual(before);
      if (fail !== "rm") {
        expect(h.commands.some((args) => args[0] === "rm")).toBe(false);
      }
    },
  );

  it("joins owned native CLI extinction before env finalization after work revocation", async () => {
    nativePipeline();
    const { owner, custody, source } = await generation();
    const context = await resolveNative(custody);
    if (!context?.backend) {
      throw new Error("missing native backend");
    }
    const rootExit = createDeferred();
    const extinction = createDeferred();
    const joining = createDeferred();
    const cancel = vi.fn();
    const spawn = vi.spyOn(getProcessSupervisor(), "spawn").mockImplementation(async (input) => ({
      activity: { resultSettled: false, lastOutputAtMs: Date.now() },
      runId: input.runId ?? "native-cli",
      startedAtMs: Date.now(),
      cancel,
      wait: async () => {
        await rootExit.promise;
        return {
          reason: "exit" as const,
          exitCode: 0,
          exitSignal: null,
          durationMs: 1,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        };
      },
      waitForExtinction: async () => {
        joining.resolve();
        await extinction.promise;
      },
    }));
    const finalize = vi.fn(context.backend.finalizeExec?.bind(context.backend));
    const target = bindNativeSandboxExecTarget(
      {
        containerName: context.containerName,
        workspaceDir,
        containerWorkdir: "/workspace",
        buildExecSpec: context.backend.buildExecSpec.bind(context.backend),
        finalizeExec: finalize,
      },
      context.backend,
    );
    const run = await runExecProcess({
      command: "true",
      workdir: workspaceDir,
      env: {},
      sandbox: target,
      scopeKey: custody.runtimeKey,
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      timeoutSec: null,
    });
    try {
      expect(spawn.mock.calls[0]?.[0].cleanupOwnership).toBeUndefined();
      rootExit.resolve();
      await Promise.race([
        joining.promise,
        run.promise.then(() => {
          throw new Error("CLI extinction was not joined");
        }),
      ]);
      source.abort(new Error("source revoked after native launch"));
      expect(run.session.finalizing).toBe(true);
      expect(run.session.exited).toBe(false);
      expect(finalize).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      extinction.resolve();
      await expect(run.promise).resolves.toMatchObject({ status: "completed", exitCode: 0 });
      expect(finalize).toHaveBeenCalledOnce();
      expect(run.session.exited).toBe(true);
    } finally {
      rootExit.resolve();
      extinction.resolve();
      await run.promise;
      await owner.release("completion");
      owner.assertCleanupConfirmed();
    }
  });

  it.each([
    { uncertain: false, allocated: false },
    { uncertain: true, allocated: false },
    { uncertain: false, allocated: true },
    { uncertain: true, allocated: true },
  ])(
    "joins local cleanup before native retirement CAS (uncertain=$uncertain, allocated=$allocated)",
    async ({ uncertain, allocated }) => {
      const local = createDeferred();
      const localCleanup = vi.fn(async () => await local.promise);
      vi.spyOn(getProcessSupervisor(), "acquireScopeCleanup").mockReturnValue(localCleanup);
      const h = nativePipeline({
        before: async (args) => {
          if (!allocated && args[0] === "image") {
            throw new Error("fixture image unavailable before dispatch");
          }
        },
      });
      const { owner, custody } = await generation();
      if (allocated) {
        await resolveNative(custody);
      } else {
        await expect(resolveNative(custody)).rejects.toThrow(
          "fixture image unavailable before dispatch",
        );
      }
      const before = await readRegistry();
      const failure = new CommandProcessCleanupError({
        cause: new Error("local CLI descendant uncertain"),
      });
      const closing = owner.release("completion");
      try {
        expect(localCleanup).toHaveBeenCalledOnce();
        expect(h.commands.some((args) => args[0] === "rm")).toBe(false);
        await expect(readRegistry()).resolves.toEqual(before);
        if (uncertain) {
          local.reject(failure);
        } else {
          local.resolve();
        }
        await closing;
        // Native retirement is still attempted after a sibling failure, but the
        // durable reservation cannot be forgotten by that later successful removal.
        expect(h.commands.filter((args) => args[0] === "rm")).toHaveLength(allocated ? 1 : 0);
        if (uncertain) {
          expect(() => owner.assertCleanupConfirmed()).toThrow(failure);
          await expect(readRegistry()).resolves.toEqual(before);
        } else {
          owner.assertCleanupConfirmed();
          await expect(readRegistry()).resolves.toEqual({ entries: [] });
        }
      } finally {
        local.resolve();
        await closing;
      }
    },
  );

  it("rereads the exact SQLite owner after wait before any removal", async () => {
    let replaceDuringWait = false;
    let replacements = 0;
    const h = nativePipeline({
      before: async (args) => {
        if (replaceDuringWait && args[0] === "wait") {
          const row = (await readRegistry()).entries[0];
          if (!row) {
            throw new Error("missing retained reservation");
          }
          const configHash = `${row.configHash}-replacement`;
          await updateRegistry({ ...row, configHash });
          expect(await readRegistryEntry(row.containerName)).toEqual({ ...row, configHash });
          replacements++;
        }
      },
    });
    const { owner, custody } = await generation();
    await resolveNative(custody);
    replaceDuringWait = true;
    await owner.release("completion");
    expect(replacements).toBe(1);
    expect(() => owner.assertCleanupConfirmed()).toThrow();
    expect(h.commands.some((args) => args[0] === "rm")).toBe(false);
    expect((await readRegistry()).entries).toHaveLength(1);
  });

  it("preserves ordinary shared reuse and builtin manager cleanup for an unmarked reserved plugin row", async () => {
    const h = nativePipeline();
    const input = { config, sessionKey: "agent:test:staff", workspaceDir };
    const a = await resolveSandboxContext(input);
    const b = await resolveSandboxContext(input);
    if (!a || !b) {
      throw new Error("missing ordinary contexts");
    }
    expect(a.runtimeId).toBe(b.runtimeId);
    expect(h.allocations.size).toBe(1);
    const row = await readRegistryEntry(a.runtimeId);
    if (!row) {
      throw new Error("missing ordinary row");
    }
    await updateRegistry({ ...row, runtimeState: "pending" });
    const reserved = await readRegistryEntry(a.runtimeId);
    if (!reserved) {
      throw new Error("missing reserved row");
    }
    await dockerSandboxBackendManager.removeRuntime({ entry: reserved, config });
    expect(h.commands.at(-1)).toEqual(["rm", "-f", a.runtimeId]);
    expect(reserved.retirementPolicy).toBeUndefined();
  });
  it("keeps reserved custom registration compatible with the builtin manager", async () => {
    const h = nativePipeline();
    const factory: ReservedSandboxBackendFactoryV1 = async (params) => ({
      id: "custom-native",
      runtimeId: params.runtimeId,
      runtimeLabel: params.runtimeId,
      workdir: "/workspace",
      buildExecSpec: async () => ({ argv: ["synthetic"], env: {}, stdinMode: "pipe-closed" }),
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    });
    const restore = registerSandboxBackend("custom-native", {
      reserveRuntimeId: () => "plugin-reserved",
      factory,
      manager: dockerSandboxBackendManager,
    });
    config.agents = {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "custom-native",
          workspaceAccess: "rw",
          scope: "shared",
          prune: { idleHours: 0, maxAgeDays: 0 },
        },
      },
    };
    try {
      const input = { config, sessionKey: "agent:test:custom", workspaceDir };
      await expect(resolveSandboxContext(input)).resolves.toMatchObject({
        runtimeId: "plugin-reserved",
      });
      await expect(resolveSandboxContext(input)).resolves.toMatchObject({
        runtimeId: "plugin-reserved",
      });
      await removeSandboxContainer("plugin-reserved");
      expect(h.commands).toEqual([["rm", "-f", "plugin-reserved"]]);
      await expect(readRegistry()).resolves.toEqual({ entries: [] });
    } finally {
      restore();
    }
  });

  it("refuses legacy partial cleanup if ownership changes during awaited setup", async () => {
    const h = nativePipeline({
      before: async (args) => {
        if (args[0] === "exec" && args.includes("fixture-setup")) {
          const name = args[2];
          if (!name) {
            throw new Error("missing setup runtime");
          }
          await updateRegistry({
            containerName: name,
            backendId: "docker",
            sessionKey: "new-private-owner",
            createdAtMs: 1,
            lastUsedAtMs: 1,
            image: "fixture:local",
            retirementPolicy: "foreground-owner",
          });
          throw new Error("setup failed after ownership changed");
        }
      },
    });
    await expect(
      resolveSandboxContext({ config, sessionKey: "agent:test:staff", workspaceDir }),
    ).rejects.toThrow("custody retained");
    expect(h.commands.some((args) => args[0] === "rm")).toBe(false);
    expect((await readRegistry()).entries).toMatchObject([
      { retirementPolicy: "foreground-owner" },
    ]);
  });

  it("refuses ordinary hot reuse when ownership changes during awaited inspection", async () => {
    let markOnInspect = false;
    const h = nativePipeline({
      before: async (args) => {
        if (markOnInspect && args.some((arg) => arg.includes("openclaw.configHash"))) {
          const name = args.at(-1);
          if (!name) {
            throw new Error("missing inspected runtime");
          }
          const row = await readRegistryEntry(name);
          if (!row) {
            throw new Error("missing inspected registry row");
          }
          await updateRegistry({ ...row, retirementPolicy: "foreground-owner" });
        }
      },
    });
    const input = { config, sessionKey: "agent:test:staff", workspaceDir };
    const first = await resolveSandboxContext(input);
    if (!first) {
      throw new Error("missing initial staff context");
    }
    markOnInspect = true;
    const count = h.commands.length;
    await expect(resolveSandboxContext(input)).rejects.toThrow("custody retained");
    expect(
      h.commands
        .slice(count)
        .some((args) => ["create", "start", "exec", "rm"].includes(args[0] ?? "")),
    ).toBe(false);
    expect(h.allocations.size).toBe(1);
    expect((await readRegistryEntry(first.runtimeId))?.retirementPolicy).toBe("foreground-owner");
  });

  it.each([
    { terminalState: "exited", restartName: "" },
    { terminalState: "exited", restartName: "no" },
    { terminalState: "stopped", restartName: "" },
    { terminalState: "stopped", restartName: "no" },
  ] as const)(
    "retires Podman $terminalState with restart policy '$restartName' after ambient drift",
    async ({ terminalState, restartName }) => {
      config.agents = {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "podman",
            scope: "shared",
            workspaceAccess: "rw",
            workspaceRoot: path.join(stateDir, "sandboxes"),
            docker: { image: "fixture:local", setupCommand: "fixture-setup" },
            prune: { idleHours: 0, maxAgeDays: 0 },
          },
        },
      };
      vi.stubEnv("CONTAINER_HOST", endpoint);
      vi.stubEnv("CONTAINER_CONNECTION", "");
      const h = nativePipeline({
        terminalState,
        restartPolicy: { Name: restartName },
        before: async (args) => {
          if (args[0] === "create") {
            vi.stubEnv("CONTAINER_HOST", "unix:///ambient-other.sock");
            vi.stubEnv("CONTAINER_CONNECTION", "other-selection");
          }
        },
      });
      const { custody, owner } = await generation();
      const context = await resolveNative(custody);
      if (!context?.backend) {
        throw new Error("missing Podman backend");
      }
      expect(context.backendId).toBe("podman");
      const row = await readRegistryEntry(context.runtimeId);
      expect(row?.backendTarget?.globalArgs).toEqual(["--url", endpoint]);
      expect(row?.retirementPolicy).toBe("foreground-owner");
      const id = h.allocations.get(context.runtimeId)?.id;
      expect(id).toMatch(/^[a-f0-9]{64}$/);
      expect(h.commands.filter((args) => args[0] === "start")).toEqual([["start", id]]);
      const spec = await context.backend.buildExecSpec({ command: "true", env: {}, usePty: false });
      try {
        expect(spec.argv.slice(0, 3)).toEqual([executable, "--url", endpoint]);
        expect(spec.env.CONTAINER_HOST).toBe(endpoint);
        expect(spec.env.CONTAINER_CONNECTION).toBe("");
      } finally {
        await context.backend.finalizeExec?.({
          token: spec.finalizeToken,
          status: "completed",
          exitCode: 0,
          timedOut: false,
        });
      }
      await owner.release("completion");
      expect(() => owner.assertCleanupConfirmed()).not.toThrow();
      expect(h.commands.filter((args) => args[0] === "rm")).toEqual([["rm", id]]);
      await expect(readRegistry()).resolves.toEqual({ entries: [] });
    },
  );
});
