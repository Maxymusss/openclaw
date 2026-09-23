import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../../../src/agents/admitted-run-context.js";
import { createOpenClawCodingTools } from "../../../../src/agents/agent-tools.js";
import { acquireExecScopeCleanup } from "../../../../src/agents/bash-tools.exec-cleanup.js";
import { prepareEmbeddedAttemptSetup } from "../../../../src/agents/embedded-agent-runner/run/attempt-setup.js";
import { createEmbeddedAttemptToolGenerationOwner } from "../../../../src/agents/embedded-agent-runner/run/attempt-tool-generation.js";
import { prepareEmbeddedAttemptToolBase } from "../../../../src/agents/embedded-agent-runner/run/attempt-tool-prepare.js";
import type { EmbeddedRunAttemptParams } from "../../../../src/agents/embedded-agent-runner/run/types.js";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  PODMAN_SANDBOX_ENGINE,
  type SandboxContainerEngine,
} from "../../../../src/agents/sandbox/container-engine.js";
import { removeSandboxContainer } from "../../../../src/agents/sandbox/manage.js";
import { readRegistryEntry } from "../../../../src/agents/sandbox/registry.js";
import { AuthStorage, ModelRegistry } from "../../../../src/agents/sessions/index.js";
import { resolveAttemptWorkspaceSandbox } from "../../../../src/agents/workspace-sandbox.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { closeOpenClawStateDatabaseAsync } from "../../../../src/state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { waitForFixtureFile } from "../../../helpers/process-wait.js";
import { createDeferred } from "../../../helpers/promise.js";

// Delay delivery of a real successful engine result, never fabricate a receipt.
const nativeDelivery = vi.hoisted(() => ({
  after: undefined as ((argv: readonly string[], stdout: string) => Promise<void>) | undefined,
}));
vi.mock("../../../../src/process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/process/exec.js")>();
  return {
    ...actual,
    spawnCommand: (...args: Parameters<typeof actual.spawnCommand>) => {
      const child = actual.spawnCommand(...args);
      const after = nativeDelivery.after;
      if (!after || !args[0].some((arg) => arg === "create" || arg === "start")) {
        return child;
      }
      return Promise.resolve(child).then(async (result) => {
        if (!result.failed && result.exitCode === 0) {
          const stdout = result.stdout;
          if (stdout === undefined) {
            throw new Error("Successful native control request returned no captured output");
          }
          await after(args[0], stdout.toString());
        }
        return result;
      });
    },
  };
});

export function createSandboxExecTestConfig(params: {
  backend: SandboxContainerEngine["id"];
  image: string;
  prefix: string;
  workspaceRoot: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        skipBootstrap: true,
        sandbox: {
          mode: "all",
          backend: params.backend,
          scope: "session",
          workspaceAccess: "rw",
          workspaceRoot: params.workspaceRoot,
          docker: {
            image: params.image,
            containerPrefix: params.prefix,
          },
          browser: { enabled: false },
          prune: { idleHours: 0, maxAgeDays: 0 },
        },
      },
    },
    tools: {
      exec: {
        host: "auto",
        security: "full",
        ask: "off",
      },
    },
  };
}

// Python is part of the canonical sandbox image. The surviving grandchild has
// no inherited environment or transport descriptors; readiness is namespace-local.
const DESCENDANT_SCRIPT = [
  "import os, sys, time, json",
  "pid = os.fork()",
  "if pid == 0:",
  "    os.setsid()",
  "    if os.fork() != 0: os._exit(0)",
  "    os.environ.clear()",
  "    for fd in range(256):",
  "        try: os.close(fd)",
  "        except OSError: pass",
  "    with open('/proc/self/stat') as f: start = f.read().split()[21]",
  "    with open('/workspace/guest-ready.tmp', 'w') as f:",
  "        json.dump({'pid': os.getpid(), 'start': start, 'env': len(os.environ)}, f)",
  "    os.replace('/workspace/guest-ready.tmp', '/workspace/guest-ready.json')",
  "    while True: time.sleep(1)",
  "os.waitpid(pid, 0)",
  "while not os.path.exists('/workspace/guest-ready.json'): time.sleep(0.01)",
  "print('guest-ready', flush=True)",
  "if sys.argv[1] != 'completion':",
  "    while True: time.sleep(1)",
].join("\n");

async function createForegroundAttempt(
  config: OpenClawConfig,
  root: string,
  workspaceDir: string,
  sessionId: string,
  sessionKey: string,
  deadlineAt: number,
) {
  const runId = randomUUID();
  const source = new AbortController();
  const originalSignal = AbortSignal.any([
    source.signal,
    AbortSignal.timeout(deadlineAt - Date.now()),
  ]);
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "native-e2e-guest",
    scopes: ["operator.sessions.write"],
    executionPolicy: "foreground-only",
    foregroundRunId: runId,
    foregroundDeadlineAt: deadlineAt,
    signal: originalSignal,
    assertCurrent: () => originalSignal.throwIfAborted(),
  });
  const admission = prepareSystemAgentRunAdmission(
    config,
    runId,
    "sandboxed-exec",
    "native-e2e",
    undefined,
    authority,
  );
  const authStorage = AuthStorage.inMemory();
  const attempt: EmbeddedRunAttemptParams = {
    config,
    runId,
    sessionId,
    sessionKey,
    workspaceDir,
    sessionFile: path.join(root, "session.jsonl"),
    prompt: "native foreground proof",
    timeoutMs: 100_000,
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
    toolsAllow: ["exec", "process", "read", "write"],
    codeModeOverride: false,
    disableToolSearch: true,
    permissionMode: "full",
    execOverrides: { host: "auto", mode: "full", ask: "off" },
    admittedRunContext: await admission.admit("embedded"),
  };
  const abort = new AbortController();
  const generation = createEmbeddedAttemptToolGenerationOwner(attempt, abort.signal);
  return { source, originalSignal, admission, attempt, abort, generation, runId };
}

export function registerNativeSandboxLifecycleTests(backend: SandboxContainerEngine["id"]) {
  const engine = backend === "docker" ? DOCKER_SANDBOX_ENGINE : PODMAN_SANDBOX_ENGINE;
  test.each(["completion", "stop", "deadline", "refresh"] as const)(
    "native foreground %s retires its private PID namespace and preserves same-session staff",
    async (mode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-foreground-"));
      const workspaceDir = path.join(root, "workspace");
      const env = captureEnv(["OPENCLAW_STATE_DIR"]);
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const sessionId = randomUUID();
      const sessionKey = `agent:sandboxed-exec:qa:${sessionId}`;
      const config = createSandboxExecTestConfig({
        backend: engine.id,
        image: process.env.OPENCLAW_SANDBOX_TEST_IMAGE ?? "openclaw-sandbox:bookworm-slim",
        prefix: `oc-qa-native-${process.pid}-`,
        workspaceRoot: path.join(root, "sandboxes"),
      });
      await fs.mkdir(path.join(workspaceDir, ".openclaw", "sandbox-skills", "skills"), {
        recursive: true,
      });
      await fs.writeFile(path.join(workspaceDir, "descendant.py"), DESCENDANT_SCRIPT);
      const deadlineAt = Date.now() + (mode === "deadline" ? 30_000 : 100_000);
      const { source, originalSignal, admission, attempt, abort, generation, runId } =
        await createForegroundAttempt(
          config,
          root,
          workspaceDir,
          sessionId,
          sessionKey,
          deadlineAt,
        );
      const staffScope = `native-e2e-staff:${runId}`;
      const cleanupStaff = acquireExecScopeCleanup(staffScope, "owned-only");
      let staffRuntime: string | undefined;
      let tools: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>> | undefined;
      let pending: Promise<unknown> | undefined;
      let confirmed = false;
      const failures: unknown[] = [];
      try {
        // Independent ordinary work in the same conversation owns a separate resource.
        const staff = await resolveAttemptWorkspaceSandbox({
          config,
          sessionId,
          sessionKey,
          workspaceDir,
        });
        if (!staff.sandbox?.backend) {
          throw new Error("missing staff sandbox");
        }
        staffRuntime = staff.sandbox.runtimeId;
        const staffExec = createOpenClawCodingTools({
          config,
          sessionId,
          sessionKey,
          cwd: workspaceDir,
          workspaceDir,
          sandbox: staff.sandbox,
          exec: { host: "auto", mode: "full", ask: "off", scopeKey: staffScope },
        }).find((tool) => tool.name === "exec");
        if (!staffExec) {
          throw new Error("missing staff exec");
        }
        const staffPending = await staffExec.execute("staff-background", {
          command: 'sleep 300 & p=$!; echo "$p" > /workspace/staff.pid; wait "$p"',
          background: true,
        });
        expect(staffPending.details).toMatchObject({ status: "running" });
        const setup = await prepareEmbeddedAttemptSetup(attempt, generation.current.nativeCustody);
        const initial = setup.readEnvironment();
        if (!initial.sandbox?.backend || !initial.sandbox.fsBridge) {
          throw new Error("missing native foreground context");
        }
        const runtimeId = initial.sandbox.runtimeId;
        expect(runtimeId).not.toBe(staffRuntime);
        const containerId = (
          await execContainer(engine, ["inspect", "--format", "{{.Id}}", runtimeId])
        ).stdout.trim();
        expect(containerId).toMatch(/^[a-f0-9]{64}$/);
        const info = JSON.parse(
          (await execContainer(engine, ["info", "--format", "{{json .}}"])).stdout,
        );
        expect(engine.id === "docker" ? info.OSType : info.host?.os).toBe("linux");
        tools = await prepareEmbeddedAttemptToolBase({
          generationOwner: generation,
          attempt,
          setup,
          agentDir: path.join(root, "agent"),
          markCoreToolStage() {},
          onYield() {},
          runAbortController: abort,
          runTrace: { traceId: "11111111111111111111111111111111" },
          skillUsagePaths: undefined,
          skillsSnapshot: undefined,
          codeModeSkills: [],
          toolSearchCatalogExecutor: async () => {
            throw new Error("unexpected catalog execution");
          },
        });
        const oldExec = tools.toolsRaw.find((tool) => tool.name === "exec");
        if (!oldExec) {
          throw new Error("missing foreground exec");
        }
        pending = oldExec.execute(
          "guest-descendant",
          {
            command: `python3 /workspace/descendant.py ${mode === "completion" ? "completion" : "hold"}`,
          },
          tools.toolAbortSignal,
        );
        const outcome = pending.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        // Observe actual grandchild readiness before stopping; CLI completion is not the condition.
        await waitForFixtureFile(path.join(workspaceDir, "guest-ready.json"), pending);
        const ready = JSON.parse(
          await fs.readFile(path.join(workspaceDir, "guest-ready.json"), "utf8"),
        );
        expect(ready).toMatchObject({
          pid: expect.any(Number),
          start: expect.stringMatching(/^\d+$/),
          env: 0,
        });
        expect(ready.pid).toBeGreaterThan(1);
        if (mode === "stop") {
          abort.abort(new Error("native e2e Stop"));
        } else if (mode === "refresh") {
          await tools.refreshPermissionMode("full", () => {});
          const next = setup.readEnvironment();
          expect(next.sandbox?.runtimeId).not.toBe(runtimeId);
          expect(next.sandbox?.workspaceDir).toBe(initial.sandbox.workspaceDir);
          await expect(
            oldExec.execute("stale-exec", { command: "touch /workspace/forbidden" }),
          ).rejects.toThrow();
          await expect(
            initial.sandbox.fsBridge.readFile({ filePath: "/workspace/descendant.py" }),
          ).rejects.toThrow();
          const write = tools.toolsRaw.find((tool) => tool.name === "write");
          const read = tools.toolsRaw.find((tool) => tool.name === "read");
          const exec = tools.toolsRaw.find((tool) => tool.name === "exec");
          if (!write || !read || !exec) {
            throw new Error("missing successor tools");
          }
          await write.execute("fresh-write", {
            path: "/workspace/fresh.txt",
            content: "successor",
          });
          expect(
            JSON.stringify(await read.execute("fresh-read", { path: "/workspace/fresh.txt" })),
          ).toContain("successor");
          expect(
            (await exec.execute("fresh-exec", { command: "cat /workspace/fresh.txt" })).details,
          ).toMatchObject({ status: "completed", exitCode: 0 });
        }
        const result = await outcome;
        if (mode === "completion") {
          expect(result).toMatchObject({
            ok: true,
            value: { details: { status: "completed", exitCode: 0 } },
          });
        } else {
          expect(result).toMatchObject({ ok: false, error: { name: "AbortError" } });
          if (mode !== "refresh") {
            expect(result).toMatchObject({
              error: { cause: mode === "stop" ? abort.signal.reason : originalSignal.reason },
            });
          }
        }
        if (mode === "deadline") {
          expect(originalSignal.aborted).toBe(true);
          expect(Date.now()).toBeGreaterThanOrEqual(deadlineAt);
        }
        await generation.release("completion");
        generation.assertCleanupConfirmed();
        confirmed = true;
        await expect(readRegistryEntry(runtimeId)).resolves.toBeUndefined();
        const removed = await execContainer(engine, ["inspect", containerId], {
          allowFailure: true,
        });
        expect(removed.code).not.toBe(0);
        expect(removed.stderr).toMatch(/no such (?:object|container)/i);
        // This probes the surviving Linux container itself, never macOS host PIDs.
        expect(
          (
            await staff.sandbox.backend.runShellCommand({
              script: 'kill -0 "$(cat /workspace/staff.pid)"',
            })
          ).code,
        ).toBe(0);
      } catch (error) {
        failures.push(error);
      } finally {
        source.abort(new Error("native e2e teardown"));
        await Promise.allSettled([pending]);
        const cleanups = await Promise.allSettled([
          ...(tools?.runCleanups.map(async (run) => await run("completion")) ?? []),
          (async () => {
            await generation.release("completion");
            generation.assertCleanupConfirmed();
            confirmed = true;
          })(),
          (async () => {
            const results = await Promise.allSettled([cleanupStaff()]);
            if (staffRuntime) {
              results.push(...(await Promise.allSettled([removeSandboxContainer(staffRuntime)])));
            }
            const failed = results.find((result) => result.status === "rejected");
            if (failed) {
              throw failed.reason;
            }
          })(),
        ]);
        cleanups.push(
          ...(await Promise.allSettled([
            Promise.resolve().then(() => admission.close()),
            closeOpenClawStateDatabaseAsync(),
            Promise.resolve().then(() => env.restore()),
          ])),
        );
        const rejected = cleanups.filter((result) => result.status === "rejected");
        failures.push(...rejected.map((result) => result.reason));
        // Any unresolved owner retains the registry and fixture workspace.
        if (confirmed && rejected.length === 0) {
          const removal = await Promise.allSettled([fs.rm(root, { recursive: true, force: true })]);
          failures.push(
            ...removal
              .filter((result) => result.status === "rejected")
              .map((result) => result.reason),
          );
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Native sandbox fixture and cleanup failed");
      }
    },
    120_000,
  );

  test.each(["create", "start"] as const)(
    "native Stop joins delivery of a real late %s receipt before confirmed retirement",
    async (command) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-late-"));
      const workspaceDir = path.join(root, "workspace");
      await fs.mkdir(path.join(workspaceDir, ".openclaw", "sandbox-skills", "skills"), {
        recursive: true,
      });
      const env = captureEnv(["OPENCLAW_STATE_DIR"]);
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const sessionId = randomUUID();
      const config = createSandboxExecTestConfig({
        backend: engine.id,
        image: process.env.OPENCLAW_SANDBOX_TEST_IMAGE ?? "openclaw-sandbox:bookworm-slim",
        prefix: `oc-qa-late-${process.pid}-`,
        workspaceRoot: path.join(root, "sandboxes"),
      });
      const { abort, admission, attempt, generation } = await createForegroundAttempt(
        config,
        root,
        workspaceDir,
        sessionId,
        `agent:sandboxed-exec:qa:${sessionId}`,
        Date.now() + 100_000,
      );
      const entered = createDeferred();
      const deliver = createDeferred();
      let heldReceipt: string | undefined;
      nativeDelivery.after = async (argv, stdout) => {
        if (argv.includes(command)) {
          heldReceipt = stdout.trim();
          entered.resolve();
          await deliver.promise;
        }
      };
      const setup = prepareEmbeddedAttemptSetup(attempt, generation.current.nativeCustody);
      const observed = setup.catch((error: unknown) => error);
      let release: Promise<void> | undefined;
      let confirmed = false;
      try {
        await Promise.race([
          entered.promise,
          observed.then(() => {
            throw new Error("native dispatch was not reached");
          }),
        ]);
        expect(heldReceipt).toMatch(/^[a-f0-9]{64}$/);
        const stopped = new Error("Stop while native result delivery is held");
        abort.abort(stopped);
        let closed = false;
        release = generation.release("abort").then(() => {
          closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        deliver.resolve();
        expect(await observed).toBe(stopped);
        await release;
        generation.assertCleanupConfirmed();
        confirmed = true;
        const removed = await execContainer(engine, ["inspect", heldReceipt ?? ""], {
          allowFailure: true,
        });
        expect(removed.code).not.toBe(0);
        expect(removed.stderr).toMatch(/no such (?:object|container)/i);
      } finally {
        nativeDelivery.after = undefined;
        deliver.resolve();
        await Promise.allSettled([setup, observed, release]);
        await generation.release("completion");
        try {
          generation.assertCleanupConfirmed();
          confirmed = true;
        } finally {
          admission.close();
          try {
            await closeOpenClawStateDatabaseAsync();
          } finally {
            env.restore();
          }
          if (confirmed) {
            await fs.rm(root, { recursive: true, force: true });
          }
        }
      }
    },
    120_000,
  );
}
