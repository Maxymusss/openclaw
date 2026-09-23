import type { Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

/** Retain the canonical targets across asynchronous authority preparation and mutation. */
export function prepareGatewaySessionLifecycleTargets(params: {
  cfg: OpenClawConfig;
  targets: readonly {
    target: Pick<GatewaySessionStoreTarget, "agentId" | "canonicalKey" | "storePath">;
    entry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  }[];
}) {
  const cfg = params.cfg;
  const preparations = params.targets.map(async ({ target, entry }) => {
    const selected = { ...target };
    const sessionId = entry?.sessionId;
    const lifecycleRevision = entry?.lifecycleRevision;
    const facts = await prepareSessionMutationFacts({
      cfg,
      sessionKey: selected.canonicalKey,
      agentId: selected.agentId,
      allowMissing: true,
    });
    return {
      matchesCurrent(currentConfig: OpenClawConfig) {
        const current = facts.readCurrent(currentConfig).target;
        return (
          facts.storageTarget.agentId === selected.agentId &&
          facts.storageTarget.storePath === selected.storePath &&
          facts.storageTarget.canonicalKey === selected.canonicalKey &&
          current?.entry.sessionId === sessionId &&
          current?.entry.lifecycleRevision === lifecycleRevision &&
          (!current ||
            (current.agentId === selected.agentId &&
              current.storePath === selected.storePath &&
              current.canonicalKey === selected.canonicalKey))
        );
      },
      bindCreation: facts.bindCreation,
      release: facts.release,
    };
  });
  for (const preparation of preparations) {
    void preparation.catch(() => {});
  }
  return {
    preparations,
    async [Symbol.asyncDispose]() {
      for (const result of await Promise.allSettled(preparations)) {
        if (result.status === "fulfilled") {
          result.value.release();
        }
      }
    },
  };
}

export function resolveSessionCreateLifecycleIntentError(
  params: Pick<
    CreateGatewaySessionParams,
    | "succeedsParent"
    | "emitCommandHooks"
    | "fork"
    | "atomicInitialization"
    | "afterCreate"
    | "initialEntry"
  >,
  parentSessionKey: string | undefined,
): ErrorShape | undefined {
  if (params.succeedsParent !== undefined) {
    if (!parentSessionKey) {
      return errorShape(ErrorCodes.INVALID_REQUEST, "succeedsParent requires parentSessionKey");
    }
    if (params.emitCommandHooks !== true) {
      return errorShape(ErrorCodes.INVALID_REQUEST, "succeedsParent requires emitCommandHooks");
    }
    if (params.succeedsParent && params.fork === true) {
      return errorShape(
        ErrorCodes.INVALID_REQUEST,
        "succeedsParent conflicts with fork: a fork runs in parallel to its parent",
      );
    }
  }
  if (params.atomicInitialization === true && (!params.afterCreate || params.initialEntry)) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "atomic initialization requires afterCreate and cannot use trusted initial state",
    );
  }
  return undefined;
}

export function resolveSessionCreateChildIntentError(
  params: Pick<CreateGatewaySessionParams, "fork" | "forkFrom" | "spawnDepth" | "spawnToolPolicy">,
  parentSessionKey: string | undefined,
): ErrorShape | undefined {
  if (params.fork === true && !parentSessionKey) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "fork requires parentSessionKey");
  }
  if (params.forkFrom && params.fork !== true) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "forkFrom requires fork=true");
  }
  if (params.spawnDepth !== undefined) {
    if (!Number.isInteger(params.spawnDepth) || params.spawnDepth < 1) {
      return errorShape(ErrorCodes.INVALID_REQUEST, "spawnDepth must be an integer >= 1");
    }
    if (!parentSessionKey) {
      return errorShape(ErrorCodes.INVALID_REQUEST, "spawnDepth requires parentSessionKey");
    }
  }
  if (params.spawnToolPolicy && params.spawnDepth === undefined) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "spawn tool policy requires spawnDepth");
  }
  return undefined;
}

export type GatewaySessionTitleModelSelection = Pick<
  SessionEntry,
  "agentRuntimeOverride" | "authProfileOverride" | "modelOverride" | "providerOverride"
>;

export type PreparedGatewaySessionLifecycle = {
  spawnedCwd?: string;
  sessionRoot?: string;
  worktree?: NonNullable<SessionEntry["worktree"]>;
  repositoryWorkspaceId?: string;
  pendingWorktree?: SessionEntry["pendingWorktree"];
  /** Reacquire source custody only around the final persistence operation. */
  withCommit?: <T>(run: (assertSourceCurrent: () => void) => Promise<T>) => Promise<T>;
  rollback?: () => Promise<void>;
};

export type PrepareGatewaySessionLifecycle = (target: {
  agentId: string;
  entry?: SessionEntry;
  key: string;
  storePath: string;
  titleModelSelection?: GatewaySessionTitleModelSelection | null;
  projectId?: string;
  /** Inherited or existing policy, resolved while the creation owner holds lifecycle custody. */
  sandboxRequired?: boolean;
}) => Promise<Result<PreparedGatewaySessionLifecycle, ErrorShape>>;

/** Bind prepared workspace facts and consume setup intent only after successful preparation. */
export function projectPreparedSessionWorkspace(
  existingEntry: SessionEntry | undefined,
  params: {
    projectId?: string;
    pendingProjectGitUrl?: string;
    pendingWorktree?: SessionEntry["pendingWorktree"];
    spawnedCwd?: string;
    preparedLifecycle?: PreparedGatewaySessionLifecycle;
  },
): Partial<SessionEntry> {
  const { projectId, pendingProjectGitUrl, pendingWorktree, spawnedCwd, preparedLifecycle } =
    params;
  const createdNewEntry = existingEntry === undefined;
  const recovered =
    preparedLifecycle?.worktree &&
    (existingEntry?.pendingWorktree || existingEntry?.pendingProjectGitUrl);
  return {
    ...(createdNewEntry && projectId ? { projectId } : {}),
    ...(createdNewEntry && pendingProjectGitUrl ? { pendingProjectGitUrl } : {}),
    ...(createdNewEntry && pendingWorktree ? { pendingWorktree } : {}),
    // Creation owns cwd adoption; public patching does not grant this authority.
    ...(spawnedCwd ? { spawnedCwd } : {}),
    ...(preparedLifecycle?.worktree ? { worktree: preparedLifecycle.worktree } : {}),
    ...(preparedLifecycle?.repositoryWorkspaceId
      ? { repositoryWorkspaceId: preparedLifecycle.repositoryWorkspaceId }
      : {}),
    ...(recovered
      ? { projectId, pendingWorktree: undefined, pendingProjectGitUrl: undefined }
      : {}),
  };
}

/** Join recorded commit actions even when the enclosing source scope fails during cleanup. */
export async function settleGatewaySessionLifecycleCommit<T>(
  commit: Promise<T>,
  afterCommit: readonly (() => void | Promise<void>)[],
): Promise<T> {
  const result: Result<T, unknown> = await commit.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  const failures: unknown[] = result.ok ? [] : [result.error];
  for (const action of afterCommit) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Session reset commit and post-commit actions failed", {
      cause: failures.at(-1),
    });
  }
  if (!result.ok) {
    throw result.error;
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  return result.value;
}

export async function rollbackGatewaySessionPreparation(params: {
  onError?: (error: unknown) => void;
  prepared?: PreparedGatewaySessionLifecycle;
}): Promise<void> {
  try {
    await params.prepared?.rollback?.();
  } catch (error) {
    params.onError?.(error);
  }
}
