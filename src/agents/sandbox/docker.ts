import { withContainerEnvFile } from "../../infra/container-env-file.js";
/**
 * Low-level Docker command helpers for sandbox runtimes.
 *
 * Wraps Docker spawn, environment sanitization, container inspection, creation, and exec behavior.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  execContainerRaw,
  readNativeSandboxEngineTarget,
  execNativeSandboxCreate,
  execNativeSandboxStart,
  type ExecContainerRawOptions,
  type ExecDockerRawResult,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
} from "./container-engine.js";
import {
  containerState,
  readContainerLabel,
  recordedPodmanContainerState,
} from "./container-inspect.js";
import {
  admitSandboxContainerSource,
  bindSandboxContainerSource,
  releaseSandboxContainerSource,
  withSandboxContainerLifecycle,
  type ContainerSourceLease,
} from "./container-lifecycle.js";
import { handleHotSandboxConfigMismatch } from "./current-config.js";
import { buildSandboxCreateArgs } from "./docker-create-args.js";
import {
  assertNativeSandboxCreatedContainer,
  assertNativeSandboxEngineCurrent,
  type NativeSandboxContainerCustody,
} from "./docker-native-custody.js";
import { throwAfterPartialSandboxCleanup } from "./docker-partial-cleanup.js";
import {
  prepareSandboxMountPlan,
  sandboxMountPlanMatchesContainer,
  type SandboxMountPlan,
} from "./mount-plan.js";
import {
  assertPodmanSandboxTarget,
  bindPodmanSandboxEngine,
  resolvePodmanSandboxConfigHash,
  resolvePodmanSandboxContainerPrefix,
  resolvePodmanSandboxCreatePolicy,
  resolvePodmanSandboxRuntimeInfo,
  resolvePodmanSandboxRuntimeInfoInternal,
  type PodmanSandboxRuntimeInfo,
} from "./podman-runtime.js";
import {
  assertSandboxRegistryEntryCurrent,
  assertSandboxRuntimeRetirementAllowed,
  completeSandboxRegistryReservation,
  readRegistryEntry,
  removeRegistryEntry,
  reserveSandboxRegistryEntry,
  updateRegistry,
  withSandboxRegistryEntryLock,
  type SandboxRegistryEntry,
} from "./registry.js";
import { resolveDockerEnvPolicyEpoch } from "./sanitize-env-vars.js";
import { buildSandboxContainerName, slugifySessionKey } from "./shared.js";
import type { SandboxConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

export {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  execContainerRaw,
  PODMAN_SANDBOX_ENGINE,
} from "./container-engine.js";
export type {
  ExecDockerRawResult,
  SandboxContainerEngine,
  SandboxContainerEngineTarget,
} from "./container-engine.js";
export { buildSandboxCreateArgs } from "./docker-create-args.js";
export { assertNativeSandboxCreatedContainer } from "./docker-native-custody.js";
export {
  bindPodmanSandboxEngine,
  resolvePodmanSandboxRuntimeInfo,
  validateSandboxContainerEngineTarget,
} from "./podman-runtime.js";
export type { PodmanSandboxRuntimeInfo } from "./podman-runtime.js";
export {
  containerState,
  dockerContainerState,
  readContainerLabel,
  readDockerContainerLabel,
  readDockerContainerEnvVar,
  readDockerPort,
} from "./container-inspect.js";
export { resolveDockerEnvPolicyEpoch } from "./sanitize-env-vars.js";

type ExecDockerRawOptions = ExecContainerRawOptions;

export async function execDockerRaw(
  args: string[],
  opts?: ExecDockerRawOptions,
): Promise<ExecDockerRawResult> {
  return await execContainerRaw(DOCKER_SANDBOX_ENGINE, args, opts);
}

const log = createSubsystemLogger("docker");

const HOT_CONTAINER_WINDOW_MS = 5 * 60 * 1000;

type ExecDockerOptions = ExecDockerRawOptions;

export async function execDocker(args: string[], opts?: ExecDockerOptions) {
  const result = await execDockerRaw(args, opts);
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    code: result.code,
  };
}

const DOCKER_DAEMON_UNAVAILABLE_MARKERS = [
  "cannot connect to the docker daemon",
  "dial unix",
  "docker daemon is not running",
  "connection refused",
];

export function isDockerDaemonUnavailable(stderr: string): boolean {
  return DOCKER_DAEMON_UNAVAILABLE_MARKERS.some((marker) => stderr.toLowerCase().includes(marker));
}

export function formatDockerDaemonUnavailableError(stderr: string): string {
  const detail = stderr.trim();
  return [
    "Sandbox mode requires Docker, but the Docker daemon is not available.",
    "Start Docker, or set `agents.defaults.sandbox.mode=off` to disable sandboxing.",
    detail ? `Docker said: ${detail}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
}

async function inspectContainerImage(
  engine: SandboxContainerEngine,
  image: string,
): Promise<"exists" | "missing"> {
  const result = await execContainer(engine, ["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return "exists";
  }
  const stderr = result.stderr.trim();
  const imageMissing =
    engine.id === "docker"
      ? stderr.toLowerCase().includes("no such image")
      : /no such image|image not known|image .* not found/iu.test(stderr);
  if (imageMissing) {
    return "missing";
  }
  if (engine.id === "docker" && isDockerDaemonUnavailable(stderr)) {
    throw new Error(formatDockerDaemonUnavailableError(stderr));
  }
  if (engine.id === "docker") {
    throw new Error(`Failed to inspect sandbox image: ${stderr}`);
  }
  throw new Error(`Failed to inspect sandbox image with ${engine.displayName}: ${stderr}`);
}

export async function ensureContainerImage(engine: SandboxContainerEngine, image: string) {
  const imageState = await inspectContainerImage(engine, image);
  if (imageState === "exists") {
    return;
  }
  if (image === DEFAULT_SANDBOX_IMAGE) {
    if (engine.id === "docker") {
      throw new Error(
        `Sandbox image not found: ${image}. Build it with scripts/sandbox-setup.sh before enabling Docker sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
      );
    }
    throw new Error(
      `Sandbox image not found in ${engine.displayName}: ${image}. Build it with podman build -t ${image} -f scripts/docker/sandbox/Dockerfile . before enabling container sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
    );
  }
  if (engine.id === "docker") {
    throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
  }
  throw new Error(
    `Sandbox image not found in ${engine.displayName}: ${image}. Build or pull it first.`,
  );
}

function appendCustomBinds(args: string[], cfg: SandboxDockerConfig): void {
  if (!cfg.binds?.length) {
    return;
  }
  for (const bind of cfg.binds) {
    args.push("-v", bind);
  }
}

async function createSandboxContainer(params: {
  engine: SandboxContainerEngine;
  name: string;
  cfg: SandboxDockerConfig;
  dockerTmpfsSource: SandboxConfig["dockerTmpfsSource"];
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  scopeKey: string;
  configHash?: string;
  mountPlan: SandboxMountPlan;
  podmanRuntimeInfo?: PodmanSandboxRuntimeInfo;
  onAllocated?: (id: string) => void;
  assertCurrent?: () => void;
  native?: NativeSandboxContainerCustody;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}) {
  const { engine, name, cfg, workspaceDir, scopeKey } = params;
  const podmanPolicy =
    engine.id === "podman" && params.podmanRuntimeInfo
      ? resolvePodmanSandboxCreatePolicy({
          cfg,
          dockerTmpfsSource: params.dockerTmpfsSource,
          workspaceDir,
          workspaceAccess: params.workspaceAccess,
          agentWorkspaceDir: params.agentWorkspaceDir,
          readOnlyWorkspaceSkillMounts: params.mountPlan.readOnlyWorkspaceSkillMounts,
          runtimeInfo: params.podmanRuntimeInfo,
        })
      : undefined;
  const createCfg = podmanPolicy?.cfg ?? cfg;
  await ensureContainerImage(engine, cfg.image);

  const { argv: args, env } = buildSandboxCreateArgs({
    name,
    cfg: createCfg,
    scopeKey,
    createdAtMs: params.native?.reservation?.createdAtMs,
    configHash: params.configHash,
    includeBinds: false,
    bindSourceRoots: [workspaceDir, params.agentWorkspaceDir],
  });
  if (podmanPolicy) {
    args.push(...podmanPolicy.extraCreateArgs);
  }
  args.push("--workdir", cfg.workdir);
  for (const bind of params.mountPlan.skippedBinds) {
    log.warn(
      `sandbox: skipping user bind "${bind}" — container path conflicts with a protected read-only skill mount`,
    );
  }
  appendCustomBinds(args, { ...cfg, binds: params.mountPlan.binds });
  const created = await withContainerEnvFile(env, async (envFile) => {
    args.push("--env-file", envFile, cfg.image, "sleep", "infinity");
    params.assertCurrent?.();
    const native = params.native;
    if (native) {
      const reservation = native.reservation;
      if (!reservation) {
        throw new Error("Native allocation requires its retained reservation.");
      }
      await assertNativeSandboxEngineCurrent(native);
      params.assertCurrent?.();
      await execNativeSandboxCreate(
        engine,
        args,
        (id) => {
          // Receipt custody precedes late cancellation and env-file cleanup.
          native.containerId = id;
        },
        () => {
          native.createAttempted = true;
        },
      );
      if (!native.containerId) {
        throw new Error("Native create returned without an allocation receipt.");
      }
      const inspected = await assertNativeSandboxCreatedContainer(
        engine,
        native.containerId,
        reservation,
      );
      if (engine.id === "podman" && typeof inspected.Namespace === "string") {
        native.namespace = inspected.Namespace;
      }
      return native.containerId;
    }
    return (await execContainer(engine, args)).stdout.trim();
  });
  const containerId = created;
  if (!/^[a-f0-9]{64}$/u.test(containerId)) {
    throw new Error("Container creation did not return an immutable container ID.");
  }
  params.onAllocated?.(containerId);
  params.assertCurrent?.();
  const executionId = containerId;
  if (params.native) {
    await assertNativeSandboxEngineCurrent(params.native);
    params.assertCurrent?.();
    const native = params.native;
    await execNativeSandboxStart(engine, executionId, () => {
      native.startAttempted = true;
    });
  } else {
    await execContainer(engine, ["start", executionId]);
  }

  if (cfg.setupCommand?.trim()) {
    params.assertCurrent?.();
    await execContainer(engine, ["exec", "-i", executionId, "/bin/sh", "-lc", cfg.setupCommand], {
      signal: params.operatorAuthority?.signal,
    });
  }
  params.assertCurrent?.();
  return containerId;
}

async function readContainerConfigHash(
  engine: SandboxContainerEngine,
  containerName: string,
): Promise<string | null> {
  return await readContainerLabel(engine, containerName, "openclaw.configHash");
}

type EnsureSandboxContainerParams = {
  workspaceSource?: "managed-worktree";
  assertCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  engine?: SandboxContainerEngine;
  podmanTarget?: SandboxContainerEngineTarget;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  readOnlyResourceMounts?: Array<{ hostPath: string; containerPath: string }>;
  cfg: SandboxConfig;
  requireCurrentConfig?: boolean;
};

export async function ensureSandboxContainer(
  params: EnsureSandboxContainerParams,
  native?: NativeSandboxContainerCustody,
) {
  const engine = params.engine ?? DOCKER_SANDBOX_ENGINE;
  const slug = native
    ? slugifySessionKey(native.custody.runtimeKey)
    : params.cfg.scope === "shared"
      ? "shared"
      : slugifySessionKey(params.scopeKey);
  const prefix =
    engine.id === "podman"
      ? resolvePodmanSandboxContainerPrefix(params.cfg.docker.containerPrefix)
      : params.cfg.docker.containerPrefix;
  const containerName = buildSandboxContainerName(prefix, slug);

  // Independent agent runs can converge on one container resource. Serialize the
  // full lifecycle so followers re-read state after create, start, or replace.
  const assertCurrent = () => {
    params.operatorAuthority?.assertCurrent();
    params.assertCurrent?.();
  };
  return await withSandboxContainerLifecycle(
    containerName,
    native || params.cfg.scope === "shared" ? undefined : params.operatorAuthority,
    (source) =>
      ensureSandboxContainerLifecycle({ ...params, assertCurrent }, containerName, source, native),
  );
}

async function ensureSandboxContainerLifecycle(
  input: EnsureSandboxContainerParams,
  containerName: string,
  source: ContainerSourceLease | undefined,
  native?: NativeSandboxContainerCustody,
) {
  let params = input;
  const configuredEngine = params.engine ?? DOCKER_SANDBOX_ENGINE;
  const podmanRuntimeInfo =
    configuredEngine.id === "podman"
      ? native
        ? await resolvePodmanSandboxRuntimeInfoInternal(configuredEngine)
        : await resolvePodmanSandboxRuntimeInfo()
      : undefined;
  if (podmanRuntimeInfo) {
    assertPodmanSandboxTarget(params.podmanTarget, podmanRuntimeInfo.target);
  }
  const engine =
    podmanRuntimeInfo && !native
      ? bindPodmanSandboxEngine(podmanRuntimeInfo.target)
      : configuredEngine;
  let existingRegistryEntry = native ? null : await readRegistryEntry(containerName);
  if (!native) {
    // A reusable native name cannot grant access to another generation's custody.
    const assertOriginalCurrent = params.assertCurrent;
    params = {
      ...params,
      assertCurrent: () => {
        assertOriginalCurrent?.();
        assertSandboxRuntimeRetirementAllowed(existingRegistryEntry ?? { containerName });
      },
    };
    params.assertCurrent?.();
  }
  if (
    existingRegistryEntry?.runtimeState === "removing" ||
    existingRegistryEntry?.runtimeState === "removing-pending"
  ) {
    throw new Error(
      `Sandbox ${containerName} is being removed; retry after sandbox recreate completes.`,
    );
  }
  if (engine.id === "podman" && existingRegistryEntry) {
    if (!existingRegistryEntry.backendTarget) {
      throw Object.assign(
        new Error(
          `Podman sandbox runtime ${containerName} has no recorded engine target. Remove that unshipped runtime manually before recreating it.`,
        ),
        { code: "INVALID_CONFIG" },
      );
    }
    try {
      assertPodmanSandboxTarget(existingRegistryEntry.backendTarget, podmanRuntimeInfo!.target);
    } catch (error) {
      if (existingRegistryEntry.backendTarget.globalArgs.length === 0) {
        throw error;
      }
      const recordedEngine = bindPodmanSandboxEngine(existingRegistryEntry.backendTarget);
      const recordedState = await recordedPodmanContainerState(recordedEngine, containerName);
      if (recordedState.exists) {
        throw error;
      }
      // A removed or replaced Podman target can leave registry metadata behind.
      // Drop it only after the recorded target no longer exposes the runtime.
      await removeRegistryEntry(containerName);
      existingRegistryEntry = null;
    }
  }
  const mountPlan = await prepareSandboxMountPlan({
    engine,
    workspaceDir: params.workspaceDir,
    workspaceSource: params.workspaceSource,
    assertCurrent: params.assertCurrent,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workdir: params.cfg.docker.workdir,
    workspaceAccess: params.cfg.workspaceAccess,
    binds: params.cfg.docker.binds,
    tmpfs: params.cfg.docker.tmpfs,
    readOnlyResourceMounts: params.readOnlyResourceMounts,
  });
  const genericConfigHash = computeSandboxConfigHash({
    docker: params.cfg.docker,
    dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(params.cfg.docker.env),
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    managedMounts: mountPlan.binds,
  });
  const expectedHash =
    engine.id === "podman"
      ? resolvePodmanSandboxConfigHash({
          genericConfigHash,
          configuredUser: Boolean(params.cfg.docker.user),
          dockerTmpfsSource: params.cfg.dockerTmpfsSource,
        })
      : genericConfigHash;
  const now = Date.now();
  if (native) {
    params.assertCurrent?.();
    const candidate: SandboxRegistryEntry = {
      containerName,
      backendId: engine.id,
      backendTarget: readNativeSandboxEngineTarget(engine),
      runtimeLabel: containerName,
      sessionKey: native.custody.runtimeKey,
      workspaceDir: params.workspaceDir,
      createdAtMs: now,
      lastUsedAtMs: now,
      image: params.cfg.docker.image,
      configLabelKind: "Image",
      configHash: expectedHash,
      retirementPolicy: "foreground-owner",
    };
    const reservation = reserveSandboxRegistryEntry(candidate);
    native.reservation = reservation;
    return await withSandboxRegistryEntryLock(reservation, async () => {
      params.assertCurrent?.();
      assertSandboxRegistryEntryCurrent(reservation);
      const containerId = await createSandboxContainer({
        engine,
        name: containerName,
        cfg: params.cfg.docker,
        dockerTmpfsSource: params.cfg.dockerTmpfsSource,
        workspaceDir: params.workspaceDir,
        workspaceAccess: params.cfg.workspaceAccess,
        agentWorkspaceDir: params.agentWorkspaceDir,
        skillsWorkspaceDir: params.skillsWorkspaceDir,
        scopeKey: native.custody.runtimeKey,
        configHash: expectedHash,
        mountPlan,
        podmanRuntimeInfo,
        assertCurrent: params.assertCurrent,
        native,
      });
      params.assertCurrent?.();
      await completeSandboxRegistryReservation(reservation, candidate);
      return { containerName, containerId };
    });
  }
  const needsSetupReservation =
    Boolean(params.cfg.docker.setupCommand?.trim()) ||
    existingRegistryEntry?.runtimeState === "pending";
  const state = await containerState(engine, containerName, { strict: needsSetupReservation });
  let containerId = "";
  if (state.exists) {
    const identity = await execContainer(
      engine,
      ["inspect", "--format", "{{.Id}}", containerName],
      {
        signal: AbortSignal.timeout(5_000),
      },
    );
    containerId = identity.stdout.trim();
    if (!/^[a-f0-9]{64}$/u.test(containerId)) {
      throw new Error("Container inspect did not return an immutable container ID.");
    }
  }
  let hasContainer = state.exists;
  let running = state.running;
  let currentHash: string | null = null;
  let hashMismatch = false;
  const registryEntry = existingRegistryEntry ?? undefined;
  if (hasContainer) {
    if (registryEntry?.runtimeState === "pending") {
      throw new Error(
        `Sandbox ${containerName} setup did not complete. Inspect the retained container and preserve needed data before explicitly recreating it.`,
      );
    }
    currentHash = await readContainerConfigHash(engine, containerName);
    if (!currentHash) {
      currentHash = registryEntry?.configHash ?? null;
    }
    hashMismatch = !currentHash || currentHash !== expectedHash;
    if (hashMismatch) {
      const lastUsedAtMs = registryEntry?.lastUsedAtMs;
      const isHot =
        running &&
        (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_CONTAINER_WINDOW_MS);
      if (isHot) {
        const mountsMatch =
          params.requireCurrentConfig ||
          (await sandboxMountPlanMatchesContainer({ engine, containerName, plan: mountPlan }));
        handleHotSandboxConfigMismatch({
          containerName,
          scope: params.cfg.scope,
          sessionKey: params.scopeKey,
          mountsChanged: !mountsMatch,
          ...(params.requireCurrentConfig !== undefined
            ? { requireCurrentConfig: params.requireCurrentConfig }
            : {}),
        });
      } else {
        params.assertCurrent?.();
        const removed = await execContainer(engine, ["rm", "-f", containerId], {
          allowFailure: true,
        });
        if (
          removed.code !== 0 &&
          !/no such (?:container|object)|does not exist/iu.test(removed.stderr)
        ) {
          throw new Error(`Sandbox replacement failed; custody retained: ${removed.stderr.trim()}`);
        }
        releaseSandboxContainerSource(engine, containerName, containerId);
        hasContainer = false;
        running = false;
      }
    }
  }
  if (!hasContainer) {
    const readyEntry = {
      containerName,
      backendId: engine.id,
      ...(podmanRuntimeInfo ? { backendTarget: podmanRuntimeInfo.target } : {}),
      runtimeLabel: containerName,
      sessionKey: params.scopeKey,
      workspaceDir: params.workspaceDir,
      createdAtMs: now,
      lastUsedAtMs: now,
      image: params.cfg.docker.image,
      configLabelKind: "Image" as const,
      configHash: expectedHash,
    };
    // Preserve managed mount custody and unfinished one-time setup before any
    // provider allocation, including a crash or revocation before publication.
    if (params.workspaceSource === "managed-worktree" || needsSetupReservation) {
      params.assertCurrent?.();
      await updateRegistry(
        needsSetupReservation ? { ...readyEntry, runtimeState: "pending" } : readyEntry,
      );
    }
    // Capture the authoritative pending row before allocation: update preserves an
    // older reservation's creation/workspace facts, which publication must compare.
    const setupReservation = needsSetupReservation ? await readRegistryEntry(containerName) : null;
    if (needsSetupReservation && !setupReservation) {
      throw new Error("Sandbox setup reservation disappeared before allocation.");
    }
    let allocated = false;
    try {
      containerId = await createSandboxContainer({
        engine,
        name: containerName,
        cfg: params.cfg.docker,
        dockerTmpfsSource: params.cfg.dockerTmpfsSource,
        workspaceDir: params.workspaceDir,
        workspaceAccess: params.cfg.workspaceAccess,
        agentWorkspaceDir: params.agentWorkspaceDir,
        skillsWorkspaceDir: params.skillsWorkspaceDir,
        scopeKey: params.scopeKey,
        configHash: expectedHash,
        mountPlan,
        podmanRuntimeInfo,
        onAllocated: (id) => {
          allocated = true;
          containerId = id;
          if (source) {
            bindSandboxContainerSource({ engine, name: containerName, id, owner: source });
          }
        },
        assertCurrent: params.assertCurrent,
        operatorAuthority: params.operatorAuthority,
      });
      if (needsSetupReservation) {
        await completeSandboxRegistryReservation(setupReservation!, readyEntry);
      } else if (params.workspaceSource !== "managed-worktree") {
        await updateRegistry(readyEntry);
      }
      params.assertCurrent?.();
      return { containerName, containerId };
    } catch (creationError) {
      if (!allocated) {
        throw creationError;
      }
      assertSandboxRuntimeRetirementAllowed({ containerName });
      if (params.operatorAuthority?.signal?.aborted) {
        // Revocation stops a proven-private generation without deleting its
        // writable layer. Shared/unknown environments remain running.
        if (params.workspaceSource !== "managed-worktree" && !needsSetupReservation) {
          await updateRegistry(readyEntry);
        }
        throw creationError;
      }
      await throwAfterPartialSandboxCleanup({
        engine,
        containerName,
        containerId,
        creationError,
        onRemoved: () => releaseSandboxContainerSource(engine, containerName, containerId),
      });
    }
  } else {
    params.assertCurrent?.();
    if (
      await admitSandboxContainerSource({
        engine,
        name: containerName,
        id: containerId,
        running,
        source,
      })
    ) {
      running = false;
    }
    params.assertCurrent?.();
    if (!running) {
      await execContainer(engine, ["start", containerId]);
    }
  }
  params.assertCurrent?.();
  await updateRegistry({
    containerName,
    backendId: engine.id,
    ...(podmanRuntimeInfo ? { backendTarget: podmanRuntimeInfo.target } : {}),
    runtimeLabel: containerName,
    sessionKey: params.scopeKey,
    workspaceDir: params.workspaceDir,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.docker.image,
    configLabelKind: "Image",
    configHash: hashMismatch ? (currentHash ?? undefined) : expectedHash,
  });
  params.assertCurrent?.();
  return { containerName, containerId };
}
