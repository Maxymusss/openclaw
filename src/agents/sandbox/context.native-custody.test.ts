import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as executablePath from "../../infra/executable-path.js";
import * as privateTemp from "../../infra/private-temp-workspace.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import { createEmbeddedAttemptToolGenerationOwner } from "../embedded-agent-runner/run/attempt-tool-generation.js";
import { registerSandboxBackend } from "./backend.js";
import type { ReservedSandboxBackendFactoryV1 } from "./backend.types.js";
import {
  bindNativeSandboxEngineTarget,
  captureNativeSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  PODMAN_SANDBOX_ENGINE,
  execContainer,
  execNativeSandboxCreate,
  readNativeSandboxExecution,
} from "./container-engine.js";
import { resolveSandboxContext, resolveSandboxContextInternal } from "./context.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
import { assertNativeSandboxCreatedContainer } from "./docker.js";
import { removeSandboxContainer } from "./manage.js";
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
let nextRun = 0;
let endpoint: string;
let executable: string;
let stateDir: string;
let workspaceDir: string;
let config: OpenClawConfig;

function commandResult(stdout = "", failure?: "cancel" | "exit") {
  return {
    failed: failure !== undefined,
    isCanceled: failure === "cancel",
    isTerminated: false,
    timedOut: false,
    isMaxBuffer: false,
    exitCode: failure === "exit" ? 1 : 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  };
}

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
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function generation() {
  const runId = `native-generation-${++nextRun}`;
  const source = new AbortController();
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "foreground-person",
    scopes: ["operator.sessions.write"],
    executionPolicy: "foreground-only",
    foregroundRunId: runId,
    foregroundDeadlineAt: Date.now() + 60_000,
    signal: source.signal,
    assertCurrent: () => source.signal.throwIfAborted(),
  });
  const admission = prepareSystemAgentRunAdmission(
    {},
    runId,
    "test",
    "native-custody-test",
    undefined,
    authority,
  );
  const owner = createEmbeddedAttemptToolGenerationOwner(
    {
      runId,
      admittedRunContext: await admission.admit("embedded"),
    },
    source.signal,
  );
  releases.push(async () => {
    await owner.release("completion");
    admission.close();
  });
  const custody = owner.current.nativeCustody;
  if (!custody) {
    throw new Error("missing actual foreground generation custody");
  }
  return { owner, custody, source };
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

describe("private native allocation construction policy", () => {
  const reservation = {
    containerName: "reserved-generation",
    sessionKey: "foreground-generation",
    createdAtMs: 1234,
    configHash: "captured-config",
  };
  const id = "c".repeat(64);

  it.each([DOCKER_SANDBOX_ENGINE, PODMAN_SANDBOX_ENGINE])(
    "accepts the exact $id construction shape on its captured endpoint",
    async (engine) => {
      const { custody } = await generation();
      const bound = bindNativeSandboxEngineTarget(captureNativeSandboxEngine(engine, custody), {
        key: "selected-engine",
        globalArgs: [engine.id === "docker" ? "--host" : "--url", endpoint],
      });
      transport.spawn.mockResolvedValue(
        commandResult(
          JSON.stringify({
            Id: id,
            Name:
              engine.id === "docker" ? `/${reservation.containerName}` : reservation.containerName,
            Config: {
              Labels: {
                "openclaw.sandbox": "1",
                "openclaw.sessionKey": reservation.sessionKey,
                "openclaw.createdAtMs": String(reservation.createdAtMs),
                "openclaw.configHash": reservation.configHash,
              },
            },
            HostConfig: {
              PidMode: engine.id === "docker" ? "" : "private",
              RestartPolicy: { Name: "no" },
              AutoRemove: false,
            },
          }),
        ),
      );
      await assertNativeSandboxCreatedContainer(bound, id, reservation);
      expect(transport.spawn).toHaveBeenCalledExactlyOnceWith(
        [
          executable,
          engine.id === "docker" ? "--host" : "--url",
          endpoint,
          "inspect",
          "--format",
          "{{json .}}",
          id,
        ],
        expect.anything(),
      );
    },
  );

  it.each([
    { changed: "ID", top: { Id: "d".repeat(64) } },
    { changed: "name", top: { Name: "/other-generation" } },
    { changed: "owner", labels: { "openclaw.sessionKey": "other-owner" } },
    { changed: "creation receipt", labels: { "openclaw.createdAtMs": "5678" } },
    { changed: "configuration", labels: { "openclaw.configHash": "other-config" } },
    { changed: "host PID namespace", host: { PidMode: "host" } },
    { changed: "joined PID namespace", host: { PidMode: "container:other" } },
    { changed: "restart policy", host: { RestartPolicy: { Name: "always" } } },
    { changed: "automatic removal", host: { AutoRemove: true } },
    { changed: "missing host policy", top: { HostConfig: null } },
  ])(
    "refuses a mismatched $changed without addressing a reusable name",
    async ({ top, labels, host }) => {
      const { custody } = await generation();
      const bound = bindNativeSandboxEngineTarget(
        captureNativeSandboxEngine(DOCKER_SANDBOX_ENGINE, custody),
        {
          key: "selected-engine",
          globalArgs: ["--host", endpoint],
        },
      );
      const inspected = {
        Id: id,
        Name: `/${reservation.containerName}`,
        Config: {
          Labels: {
            "openclaw.sandbox": "1",
            "openclaw.sessionKey": reservation.sessionKey,
            "openclaw.createdAtMs": String(reservation.createdAtMs),
            "openclaw.configHash": reservation.configHash,
            ...labels,
          },
        },
        HostConfig: { PidMode: "", RestartPolicy: { Name: "no" }, AutoRemove: false, ...host },
        ...top,
      };
      transport.spawn.mockResolvedValue(commandResult(JSON.stringify(inspected)));
      await expect(assertNativeSandboxCreatedContainer(bound, id, reservation)).rejects.toThrow(
        "reserved owner or construction policy",
      );
      expect(transport.spawn).toHaveBeenCalledExactlyOnceWith(
        [executable, "--host", endpoint, "inspect", "--format", "{{json .}}", id],
        expect.anything(),
      );
    },
  );
});

// This fixture mocks only transport. Resolver, native factory, env staging,
// generation cleanup and the SQLite reservation owner remain real.
function nativePipeline(
  options: {
    before?: (args: string[]) => Promise<void>;
    createOutput?: string;
    inspectOverride?: Record<string, unknown>;
  } = {},
) {
  const allocations = new Map<string, { id: string; labels: Record<string, string> }>();
  const commands: string[][] = [];
  transport.spawn.mockImplementation(async (argv: string[]) => {
    const args = argv.slice(argv[1] === "--host" || argv[1] === "--url" ? 3 : 1);
    commands.push(args);
    await options.before?.(args);
    if (args[0] === "info") {
      return commandResult("false\ttrue\t" + endpoint.slice("unix://".length) + "\t5.8.2\n");
    }
    if (args[0] === "system") {
      return commandResult("[]");
    }
    if (args[0] === "image") {
      return commandResult();
    }
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1];
      if (!name) {
        throw new Error("missing real create name");
      }
      const labels: Record<string, string> = {};
      for (let index = 0; index < args.length; index++) {
        if (args[index] !== "--label") {
          continue;
        }
        const pair = args[index + 1] ?? "";
        const separator = pair.indexOf("=");
        labels[pair.slice(0, separator)] = pair.slice(separator + 1);
      }
      const id = String(allocations.size + 1).padStart(64, "a");
      allocations.set(name, { id, labels });
      return commandResult(options.createOutput ?? id);
    }
    if (args.includes("--type")) {
      // Containerized test runners still exercise the canonical namespace probe.
      return commandResult(
        JSON.stringify({
          Id: "f".repeat(64),
          Mounts: [{ Type: "bind", Source: stateDir, Destination: stateDir, RW: true }],
          Tmpfs: null,
        }),
      );
    }
    if (args[0] === "exec" && args.includes("-e")) {
      return commandResult(
        JSON.stringify([
          fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
          fs.readlinkSync("/proc/self/ns/mnt"),
        ]),
      );
    }
    const allocation = [...allocations.entries()].find(
      ([name, value]) => args.includes(name) || args.includes(value.id),
    );
    if (args[0] === "inspect") {
      if (!allocation) {
        return { ...commandResult("", "exit"), stderr: Buffer.from("No such container") };
      }
      const [name, value] = allocation;
      if (args.includes("{{json .}}")) {
        return commandResult(
          JSON.stringify({
            Id: value.id,
            Name: argv[1] === "--url" ? name : "/" + name,
            Config: { Labels: value.labels },
            HostConfig: {
              PidMode: argv[1] === "--url" ? "private" : "",
              RestartPolicy: { Name: "no" },
              AutoRemove: false,
            },
            ...options.inspectOverride,
          }),
        );
      }
      if (args.includes("{{.Id}}")) {
        return commandResult(value.id);
      }
      if (args.includes("{{.State.Running}}")) {
        return commandResult("true");
      }
      if (args.some((arg) => arg.includes("openclaw.configHash"))) {
        return commandResult(value.labels["openclaw.configHash"]);
      }
      if (args.some((arg) => arg.includes("Mounts"))) {
        return commandResult(JSON.stringify({ Mounts: [], Tmpfs: null }));
      }
    }
    if (args.includes("/proc/self/mountinfo")) {
      return commandResult("1 1 0:1 / / rw - overlay overlay rw\n");
    }
    if (args[0] === "start" || args[0] === "exec" || args[0] === "rm") {
      return commandResult();
    }
    throw new Error("unexpected native fixture command: " + args[0]);
  });
  return { commands, allocations };
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
    await first.owner.release("completion");
    await first.owner.release("completion");
    expectUncertainCleanup(first.owner, "qualified extinction");
    expect(() => first.owner.replace()).toThrow("qualified cleanup");
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await expect(readRegistry()).resolves.toEqual({ entries: rows });
    const before = h.commands.length;
    await expect(removeSandboxContainer(a.runtimeId)).rejects.toThrow("custody retained");
    expect(h.commands).toHaveLength(before);
    expect(h.commands.some((args) => args[0] === "rm")).toBe(false);
  });

  it.each(["create", "start"] as const)(
    "joins a late %s after Stop without setup or handle exposure",
    async (heldCommand) => {
      const entered = createDeferred();
      const finish = createDeferred();
      const h = nativePipeline({
        before: async (args) => {
          if (args[0] === heldCommand) {
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
        release = owner.release("abort").then(() => {
          released = true;
        });
        await Promise.resolve();
        expect(released).toBe(false);
        finish.resolve();
        await failed;
        await release;
        expectUncertainCleanup(
          owner,
          heldCommand === "start" ? "qualified extinction" : "removal remains unconfirmed",
        );
        expect(h.commands.filter((args) => args[0] === "start")).toHaveLength(
          heldCommand === "start" ? 1 : 0,
        );
        expect(
          h.commands.some((args) => args[0] === "exec" && args.includes("fixture-setup")),
        ).toBe(false);
        expect(h.commands.some((args) => args[0] === "rm")).toBe(false);
        await expect(readRegistry()).resolves.toEqual({ entries: pendingRows });
      } finally {
        finish.resolve();
        await Promise.allSettled([pending, release, failed]);
      }
    },
  );

  it("retains successful allocation when the real env-file cleanup reports failure", async () => {
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
    expectUncertainCleanup(owner, "removal remains unconfirmed");
    expect((await readRegistry()).entries).toMatchObject([
      { retirementPolicy: "foreground-owner", runtimeState: "pending" },
    ]);
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
      expectUncertainCleanup(owner, "removal remains unconfirmed");
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

  it("keeps the actual Podman pipeline bound to its captured Unix selection after ambient drift", async () => {
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
    expectUncertainCleanup(owner, "qualified extinction");
    expect(h.commands.some((args) => args[0] === "rm")).toBe(false);
  });
});
