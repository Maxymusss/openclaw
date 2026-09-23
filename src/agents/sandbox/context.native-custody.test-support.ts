import fs from "node:fs";
import { expect, type Mock } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import { createEmbeddedAttemptToolGenerationOwner } from "../embedded-agent-runner/run/attempt-tool-generation.js";
import { readRegistryEntry, updateRegistry } from "./registry.js";
let nextRun = 0;

export function commandResult(stdout = "", failure?: "cancel" | "exit") {
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

// This fixture mocks only transport. Resolver, native factory, env staging,
// generation cleanup and the SQLite reservation owner remain real.
export type NativePipelineOptions = {
  before?: (args: string[]) => Promise<void>;
  createOutput?: string;
  inspectOverride?: Record<string, unknown>;
  infoOverride?: Record<string, unknown>;
  fail?: (args: string[]) => boolean;
  terminalState?: "exited" | "stopped";
  restartPolicy?: unknown;
};

export function createNativePipeline(
  {
    spawn,
    stateDir,
    endpoint,
  }: { spawn: Pick<Mock, "mockImplementation">; stateDir: string; endpoint: string },
  options: NativePipelineOptions = {},
) {
  const allocations = new Map<
    string,
    { id: string; labels: Record<string, string>; state: "created" | "running" | "exited" }
  >();
  let nextId = 0;
  const commands: string[][] = [];
  spawn.mockImplementation(async (argv: string[]) => {
    const args = argv.slice(argv[1] === "--host" || argv[1] === "--url" ? 3 : 1);
    commands.push(args);
    await options.before?.(args);
    if (options.fail?.(args)) {
      return commandResult("", "exit");
    }
    if (args[0] === "info" && args.includes("{{json .}}")) {
      return commandResult(
        JSON.stringify({
          ID: "fixture-daemon",
          OSType: "linux",
          host: {
            os: "linux",
            security: { rootless: true },
            idMappings: { uidmap: [], gidmap: [] },
          },
          store: {
            graphRoot: "/fixture/storage",
            runRoot: "/fixture/run",
            graphDriverName: "overlay",
          },
          ...options.infoOverride,
        }),
      );
    }
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
      const id = String(++nextId).padStart(64, "a");
      allocations.set(name, { id, labels, state: "created" });
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
            Namespace: "",
            State: {
              Status: value.state === "exited" ? (options.terminalState ?? "exited") : value.state,
              Running: value.state === "running",
              Pid: value.state === "running" ? 12 : 0,
              Paused: false,
              Restarting: false,
              Dead: false,
              Error: "",
              ExitCode: value.state === "exited" ? 137 : 0,
              StartedAt:
                value.state === "created" ? "0001-01-01T00:00:00Z" : "2026-01-01T00:00:00Z",
              FinishedAt:
                value.state === "exited" ? "2026-01-01T00:00:01Z" : "0001-01-01T00:00:00Z",
            },
            Config: { Labels: value.labels },
            HostConfig: {
              PidMode: argv[1] === "--url" ? "private" : "",
              RestartPolicy: Object.hasOwn(options, "restartPolicy")
                ? options.restartPolicy
                : { Name: "" },
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
        return commandResult(String(value.state === "running"));
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
    if (args[0] === "start" && allocation) {
      allocation[1].state = "running";
      return commandResult();
    }
    if (args[0] === "kill" && allocation) {
      allocation[1].state = "exited";
      return commandResult();
    }
    if (args[0] === "wait" && allocation) {
      return commandResult(allocation[1].state === "exited" ? "137" : "0");
    }
    if (args[0] === "rm") {
      if (allocation) {
        allocations.delete(allocation[0]);
      }
      return commandResult();
    }
    if (args[0] === "exec") {
      return commandResult();
    }
    throw new Error("unexpected native fixture command: " + args[0]);
  });
  return { commands, allocations };
}

export async function markPendingAllocationForForegroundRetirement(
  allocations: ReadonlyMap<string, { id: string }>,
  containerId: string | undefined,
) {
  const allocation = [...allocations].find(([, value]) => value.id === containerId);
  if (!allocation) {
    throw new Error("missing setup allocation");
  }
  const [name, value] = allocation;
  const row = await readRegistryEntry(name);
  if (!row) {
    throw new Error("missing setup reservation");
  }
  expect(row.runtimeState).toBe("pending");
  const entry = { ...row, retirementPolicy: "foreground-owner" } satisfies typeof row;
  await updateRegistry(entry);
  return { entry, containerId: value.id };
}

export async function createNativeGeneration(releases: Array<() => Promise<void>>) {
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
