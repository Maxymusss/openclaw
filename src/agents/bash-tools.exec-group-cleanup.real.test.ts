import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { getSession, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { acquireExecScopeCleanup } from "./bash-tools.exec-cleanup.js";
import { createExecTool } from "./bash-tools.exec-run.js";

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisor,
}));

let supervisor: ReturnType<typeof createProcessSupervisor>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  supervisor = createProcessSupervisor();
});
afterEach(async () => {
  await supervisor.shutdown();
  resetProcessRegistryForTests();
});

it.skipIf(process.platform === "win32")(
  "releases every completed exec group while the owning session stays open",
  async () => {
    const cwd = tempDirs.make("exec-group-cleanup-");
    const fixture = path.join(cwd, "command.cjs");
    await fs.writeFile(
      fixture,
      `const { spawn, execFileSync } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
  stdio: ["ignore", "ignore", "ignore", 3],
});
child.unref();
child.once("spawn", () => {
  const relay = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }).trim());
  process.stdout.write(JSON.stringify([child.pid, process.ppid, relay]));
});
`,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const pids: number[] = [];
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "exec-group-cleanup-test",
        OPENCLAW_STATE_DIR: path.join(cwd, "state"),
        OPENCLAW_HOME: cwd,
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
        SHELL: "/bin/sh",
      },
      async () => {
        const exec = createExecTool({
          host: "gateway",
          mode: "full",
          ask: "off",
          allowBackground: false,
          notifyOnExit: false,
          scopeKey: "agent:main:exec-group-cleanup",
          cwd,
        });
        for (let call = 0; call < 5; call += 1) {
          const result = await exec.execute(`exec-${call}`, {
            command: `exec ${quote(process.execPath)} ${quote(fixture)}`,
          });
          expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
          if (result.details.status !== "completed") {
            throw new Error("exec did not complete");
          }
          const group: number[] = JSON.parse(result.details.aggregated);
          expect(group).toHaveLength(3);
          expect(group.every((pid) => Number.isSafeInteger(pid) && pid > 1)).toBe(true);
          pids.push(...group);
        }
        // Completed output remains available without retaining the process group.
        expect(pids.filter(isPidAlive)).toEqual([]);
      },
    );
  },
);

it.skipIf(process.platform === "win32").each(["complete", "stop", "deadline"] as const)(
  "owns foreground POSIX descendants through %s while leaving same-session staff background work alive",
  async (outcome) => {
    const cwd = tempDirs.make("foreground-exec-tree-");
    const fixture = path.join(cwd, "tree.cjs");
    const ready = path.join(cwd, "ready.json");
    await fs.writeFile(
      fixture,
      `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
  stdio: ["ignore", "ignore", "ignore", 3],
});
child.unref();
child.once("spawn", () => {
  fs.writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
  if (process.argv[3] !== "complete") setTimeout(() => {}, 30000);
});
`,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_STATE_DIR: path.join(cwd, "state"),
        OPENCLAW_HOME: cwd,
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
        SHELL: "/bin/sh",
      },
      async () => {
        const sessionKey = "agent:main:mixed-owners";
        const guestScope = `foreground:${outcome}`;
        const defaults = {
          host: "gateway",
          mode: "full",
          ask: "off",
          notifyOnExit: false,
          cwd,
        } as const;
        const staff = createExecTool({ ...defaults, scopeKey: sessionKey, allowBackground: true });
        const staffResult = await staff.execute("staff-background", {
          command: "exec sleep 30",
          background: true,
        });
        if (staffResult.details.status !== "running") {
          throw new Error("Expected ordinary staff background execution");
        }
        const staffSession = getSession(staffResult.details.sessionId);
        const staffPid = staffSession?.pid;
        if (!staffPid) {
          throw new Error("Expected real staff child PID");
        }
        const cleanup = acquireExecScopeCleanup(guestScope, "required-all");
        const stop = new AbortController();
        const signal = outcome === "deadline" ? AbortSignal.timeout(2000) : stop.signal;
        const authority = createAdmittedRunOperatorAuthority({
          profileId: "guest",
          scopes: ["operator.sessions.write"],
          executionPolicy: "foreground-only",
          assertCurrent: () => signal.throwIfAborted(),
          signal,
        });
        const guest = createExecTool(
          { ...defaults, scopeKey: guestScope, allowBackground: false },
          authority,
        );
        const execution = guest
          .execute(
            "guest-exec",
            {
              command: `exec ${quote(process.execPath)} ${quote(fixture)} ${quote(ready)} ${outcome}`,
            },
            signal,
          )
          .then(
            (value) => value,
            (error: unknown) => error,
          );
        try {
          let pids: number[] = [];
          await vi.waitFor(async () => {
            pids = JSON.parse(await fs.readFile(ready, "utf8"));
            expect(pids).toHaveLength(2);
            expect(pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)).toBe(true);
          });
          if (outcome === "stop") {
            stop.abort(new Error("user stopped foreground turn"));
          }
          const result = await execution;
          if (outcome === "complete") {
            expect(result).toMatchObject({ details: { status: "completed", exitCode: 0 } });
          } else {
            expect(signal.aborted).toBe(true);
            expect(result).toBeInstanceOf(Error);
          }
          await cleanup();
          expect(pids.filter(isPidAlive)).toEqual([]);
          expect(isPidAlive(staffPid)).toBe(true);
          expect(getSession(staffResult.details.sessionId)?.backgrounded).toBe(true);
        } finally {
          stop.abort();
          await execution;
          await Promise.allSettled([cleanup()]);
          supervisor.cancelScope(sessionKey);
          await waitForExecScope(sessionKey);
        }
      },
    );
  },
);
