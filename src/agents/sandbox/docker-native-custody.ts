import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import {
  execContainer,
  readNativeSandboxEngineTarget,
  runNativeSandboxCleanup,
  type NativeSandboxCustody,
  type SandboxContainerEngine,
} from "./container-engine.js";
import {
  assertSandboxRegistryEntryCurrent,
  completeSandboxRegistryReservation,
  withSandboxRegistryEntryLock,
  type SandboxRegistryEntry,
} from "./registry.js";

type NativeCommand = (
  args: string[],
  allowFailure?: boolean,
) => Promise<{
  stdout: string;
  stderr: string;
  code: number;
}>;

/** Private allocation facts; neither transport completion nor a reusable name is custody. */
export type NativeSandboxContainerCustody = {
  custody: NativeSandboxCustody;
  engine?: SandboxContainerEngine;
  engineIdentity?: Awaited<ReturnType<typeof readNativeSandboxEngineIdentity>>;
  namespace?: string;
  reservation?: SandboxRegistryEntry;
  containerId?: string;
  createAttempted: boolean;
  startAttempted: boolean;
};

/** Server facts, not the local CLI's OS. Podman identity is its selected store/principal. */
export async function readNativeSandboxEngineIdentity(
  engine: SandboxContainerEngine,
  exec?: NativeCommand,
) {
  const result = await (exec ?? ((args) => execContainer(engine, args)))([
    "info",
    "--format",
    "{{json .}}",
  ]);
  const info: unknown = JSON.parse(result.stdout);
  if (!isRecord(info) || !readNativeSandboxEngineTarget(engine)) {
    throw new Error("Native sandbox engine identity is unavailable.");
  }
  if (engine.id === "docker") {
    if (info.OSType !== "linux" || typeof info.ID !== "string" || !info.ID) {
      throw new Error("Foreground sandbox cleanup requires an identified Linux Docker daemon.");
    }
    return { kind: "docker" as const, id: info.ID };
  }
  const host = isRecord(info.host) ? info.host : undefined;
  const security = host && isRecord(host.security) ? host.security : undefined;
  const store = isRecord(info.store) ? info.store : undefined;
  if (
    host?.os !== "linux" ||
    typeof security?.rootless !== "boolean" ||
    typeof store?.graphRoot !== "string" ||
    !store.graphRoot.startsWith("/") ||
    typeof store.runRoot !== "string" ||
    !store.runRoot.startsWith("/") ||
    typeof store.graphDriverName !== "string" ||
    !store.graphDriverName ||
    !isRecord(host.idMappings)
  ) {
    throw new Error("Foreground sandbox cleanup requires an identified Linux Podman store.");
  }
  return {
    kind: "podman" as const,
    graphRoot: store.graphRoot,
    runRoot: store.runRoot,
    driver: store.graphDriverName,
    rootless: security.rootless,
    // Preserve the server's UID/GID maps, independent of client credentials.
    idMappings: structuredClone(host.idMappings),
  };
}

export async function assertNativeSandboxEngineCurrent(native: NativeSandboxContainerCustody) {
  const { engine, engineIdentity } = native;
  if (
    !engine ||
    !engineIdentity ||
    !isDeepStrictEqual(await readNativeSandboxEngineIdentity(engine), engineIdentity)
  ) {
    throw new Error("Native sandbox engine identity changed.");
  }
  native.custody.assertCurrent();
}

/** The exact allocation must retain its private namespace and non-restarting policy. */
export async function assertNativeSandboxCreatedContainer(
  engine: SandboxContainerEngine,
  containerId: string,
  reservation: Pick<
    SandboxRegistryEntry,
    "containerName" | "sessionKey" | "createdAtMs" | "configHash"
  >,
  exec?: NativeCommand,
) {
  if (!readNativeSandboxEngineTarget(engine) || !/^[a-f0-9]{64}$/u.test(containerId)) {
    throw new Error("Native sandbox inspection requires its captured target and immutable ID.");
  }
  const result = await (exec ?? ((args) => execContainer(engine, args)))([
    "inspect",
    "--format",
    "{{json .}}",
    containerId,
  ]);
  const value: unknown = JSON.parse(result.stdout);
  const config = isRecord(value) && isRecord(value.Config) ? value.Config : undefined;
  const labels = config && isRecord(config.Labels) ? config.Labels : undefined;
  const host = isRecord(value) && isRecord(value.HostConfig) ? value.HostConfig : undefined;
  const restart = host && isRecord(host.RestartPolicy) ? host.RestartPolicy : undefined;
  // Both engines expose an omitted non-restarting policy as ""; a missing field is unknown.
  // Docker's private PID mode is empty; Podman's inspect producer emits private.
  const expectedName =
    engine.id === "docker" ? `/${reservation.containerName}` : reservation.containerName;
  if (
    !isRecord(value) ||
    value.Id !== containerId ||
    value.Name !== expectedName ||
    labels?.["openclaw.sandbox"] !== "1" ||
    labels?.["openclaw.sessionKey"] !== reservation.sessionKey ||
    labels?.["openclaw.createdAtMs"] !== String(reservation.createdAtMs) ||
    (reservation.configHash !== undefined &&
      labels?.["openclaw.configHash"] !== reservation.configHash) ||
    host?.PidMode !== (engine.id === "docker" ? "" : "private") ||
    host?.AutoRemove !== false ||
    !(restart?.Name === "no" || restart?.Name === "") ||
    (engine.id === "podman" && typeof value.Namespace !== "string")
  ) {
    throw new Error(
      "Native sandbox allocation did not match its reserved owner or construction policy.",
    );
  }
  return value;
}

function assertExited(
  engine: SandboxContainerEngine,
  value: Record<string, unknown>,
  exitCode: string,
) {
  const state = isRecord(value.State) ? value.State : undefined;
  const started = typeof state?.StartedAt === "string" ? Date.parse(state.StartedAt) : Number.NaN;
  const finished =
    typeof state?.FinishedAt === "string" ? Date.parse(state.FinishedAt) : Number.NaN;
  if (
    !(state?.Status === "exited" || (engine.id === "podman" && state?.Status === "stopped")) ||
    state?.Running !== false ||
    state.Paused !== false ||
    state.Restarting !== false ||
    state.Dead !== false ||
    state.Pid !== 0 ||
    state.Error !== "" ||
    typeof state.ExitCode !== "number" ||
    !Number.isInteger(state.ExitCode) ||
    state.ExitCode < 0 ||
    String(state.ExitCode) !== exitCode.trim() ||
    !Number.isFinite(started) ||
    started <= 0 ||
    !Number.isFinite(finished) ||
    finished < started
  ) {
    // Podman can synthesize stopped/PID0 after losing conmon. A real exit
    // receipt (not -1/Error or never-started wait success) is required.
    throw new Error("Native sandbox process extinction is unconfirmed.");
  }
}

export async function retireNativeSandboxContainer(native: NativeSandboxContainerCustody) {
  const reservation = native.reservation;
  if (!reservation) {
    return;
  }
  try {
    await withSandboxRegistryEntryLock(reservation, async () => {
      assertSandboxRegistryEntryCurrent(reservation);
      if (!native.createAttempted) {
        native.custody.assertCleanupConfirmed();
        completeSandboxRegistryReservation(reservation);
        return;
      }
      const { engine, engineIdentity, containerId } = native;
      if (!engine || !engineIdentity || !containerId) {
        throw new Error("Native sandbox allocation receipt is missing; custody is retained.");
      }
      await runNativeSandboxCleanup(engine, async (raw) => {
        const exec: NativeCommand = async (args, allowFailure) => {
          assertSandboxRegistryEntryCurrent(reservation);
          const result = await raw(args, allowFailure);
          assertSandboxRegistryEntryCurrent(reservation);
          return {
            ...result,
            stdout: result.stdout.toString("utf8"),
            stderr: result.stderr.toString("utf8"),
          };
        };
        const inspect = async () => {
          if (
            !isDeepStrictEqual(await readNativeSandboxEngineIdentity(engine, exec), engineIdentity)
          ) {
            throw new Error("Native sandbox engine identity changed; custody is retained.");
          }
          const value = await assertNativeSandboxCreatedContainer(
            engine,
            containerId,
            reservation,
            exec,
          );
          if (native.namespace !== undefined && value.Namespace !== native.namespace) {
            throw new Error("Native sandbox namespace changed; custody is retained.");
          }
          return value;
        };
        let value = await inspect();
        if (native.startAttempted) {
          if (isRecord(value.State) && value.State.Running === true) {
            // A concurrent natural exit can make kill fail. Only subsequent
            // wait plus exact exit inspection can resolve that race.
            await exec(["kill", "--signal", "KILL", containerId], true);
          }
          const waited = await exec(["wait", containerId]);
          value = await inspect();
          assertExited(engine, value, waited.stdout);
        } else {
          const state = isRecord(value.State) ? value.State : undefined;
          if (state?.Status !== "created" || state.Running !== false || state.Pid !== 0) {
            throw new Error("Never-started sandbox allocation changed state; custody is retained.");
          }
        }
        // Non-force removal cannot substitute for namespace extinction. A missing
        // resource is not our removal receipt, so any command failure retains the row.
        await exec(["rm", containerId]);
      });
      // Scope settlement and earlier generation cleanup must both succeed before CAS.
      native.custody.assertCleanupConfirmed();
      completeSandboxRegistryReservation(reservation);
    });
  } catch (cause) {
    throw new CommandProcessCleanupError({ cause });
  }
}
