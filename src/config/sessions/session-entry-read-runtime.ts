import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  isIncognitoSessionKey,
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import {
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
  type AgentDatabaseRegistryChange,
} from "../../state/openclaw-agent-db-registry-listing.js";
import {
  listOpenIncognitoAgentDatabases,
  retainOpenClawAgentDatabaseReadCandidates,
} from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { loadSessionEntry } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteAgentId, resolveSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import {
  captureCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import {
  captureSessionStoreReadCandidates,
  type SessionStoreTargetReadRequest,
  type SessionStoreTargetReadResult,
} from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type {
  SessionExactEntriesWorkerResult,
  SessionHistoryWorkerDatabase,
} from "./session-transcript-worker.types.js";
import type { SessionEntry } from "./types.js";

type PreparedStoreTarget = Extract<SessionStoreTargetReadResult, { kind: "session-store-target" }>;
type StoreTargetReadOwner = {
  assertCurrent: () => void;
  onRegistryChange: (change: AgentDatabaseRegistryChange) => void;
  revalidateTarget: () => Promise<void>;
};

async function withSessionStoreTarget<T>(
  request: Omit<SessionStoreTargetReadRequest, "registeredDatabases">,
  operation: (target: PreparedStoreTarget, owner: StoreTargetReadOwner) => Promise<T>,
  assertCallerCurrent?: () => void,
): Promise<T> {
  assertCallerCurrent?.();
  const { candidates, ...targetRequest } = request;
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env: targetRequest.env });
  return withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
    let resolved = await discovery.readStoreTarget({
      ...targetRequest,
      registeredDatabases: { status: "deferred" },
    });
    let registry: Awaited<ReturnType<typeof registryRead.read>> | undefined;
    if (resolved.kind === "session-target-registry-required") {
      registry = await registryRead.read();
      registry.assertCurrent();
      discovery.assertCurrent();
      assertCallerCurrent?.();
      resolved = await discovery.readStoreTarget({
        ...targetRequest,
        registeredDatabases:
          registry.result.status === "available"
            ? registry.result.entries
            : { status: "unavailable" },
      });
      if (resolved.kind === "session-target-registry-required") {
        throw new Error("Session store target requested registry rows twice");
      }
    }
    registry?.assertCurrent();
    const target = resolved;
    const assertCurrent = () => {
      registry?.assertCurrent();
      discovery.assertCurrent();
      assertSessionStoreReadCandidate(target.sourcePath, candidates);
      assertCallerCurrent?.();
    };
    let registrationChanged = false;
    assertCurrent();
    // A synchronous consumer may already publish; its operation owns the final currentness check.
    const result = await operation(target, {
      assertCurrent,
      onRegistryChange(change) {
        if (registry) {
          registry.followRegistration(change);
          registrationChanged = true;
        }
      },
      async revalidateTarget() {
        assertCurrent();
        if (!registrationChanged) {
          return;
        }
        const currentRegistry = await registryRead.read();
        assertCurrent();
        currentRegistry.assertCurrent();
        const current = await discovery.readStoreTarget({
          ...targetRequest,
          registeredDatabases:
            currentRegistry.result.status === "available"
              ? currentRegistry.result.entries
              : { status: "unavailable" },
        });
        assertCurrent();
        currentRegistry.assertCurrent();
        if (
          current.kind !== "session-store-target" ||
          current.logicalAgentId !== target.logicalAgentId ||
          current.sourcePath !== target.sourcePath ||
          current.database.agentId !== target.database.agentId ||
          current.database.path !== target.database.path
        ) {
          throw new Error("Session store registration changed its selected target");
        }
        registrationChanged = false;
      },
    });
    if (registrationChanged) {
      throw new Error("Session read released its owner before confirming registration");
    }
    return result;
  });
}

/** Preserve logical lookup and writable open semantics on the canonical file-backed actor. */
export async function readSessionEntryInWorker(
  input: SessionAccessScope,
  assertCallerCurrent: () => void,
) {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const scope = { ...input, env };
  assertCallerCurrent();
  const agentId = scope.agentId
    ? normalizeAgentId(scope.agentId)
    : parseAgentSessionKey(scope.sessionKey)?.agentId;
  let storePath = scope.storePath ? path.resolve(scope.storePath) : undefined;
  // Incognito still belongs to its process-held native owner until that owner's complete cutover.
  if (
    isIncognitoSessionKey(scope.sessionKey) ||
    (storePath &&
      (isIncognitoOpenClawAgentSqlitePath(storePath, {
        agentId: agentId ?? scope.defaultAgentId ?? LEGACY_IMPLICIT_AGENT_ID,
        env,
      }) ||
        listOpenIncognitoAgentDatabases().some((owner) => owner.storePath === storePath)))
  ) {
    return loadSessionEntry(scope);
  }
  if (!storePath) {
    if (!agentId) {
      throw new Error("Cannot resolve SQLite session scope without an agent id");
    }
    storePath = resolveOpenClawAgentSqlitePath({ agentId, env });
  }
  const candidates = captureSessionStoreReadCandidates(storePath);
  const loadedRead = await withSessionStoreTarget(
    { agentId, defaultAgentId: scope.defaultAgentId, storePath, env, candidates },
    async (target, owner) => {
      const sessionKey = resolveSqliteSessionKey(scope.sessionKey, target.logicalAgentId);
      const options = { ...target.database, env };
      const execution = captureOpenClawAgentDatabaseExecution(options);
      const assertCurrent = () => {
        execution.assertCurrent();
        owner.assertCurrent();
      };
      let entry: SessionEntry | undefined;
      try {
        entry = await runOpenClawAgentWorkerWrite(options, () =>
          execution.runCreate(
            {
              assertCurrent,
              onRegistryChange: owner.onRegistryChange,
              createAdmission(binding) {
                return () => ({
                  nativeLocations: binding.nativeLocations,
                  admission: createSqliteWorkerOperationAdmission((request, grant) => {
                    binding.authorize(request);
                    assertCurrent();
                    if (!grant()) {
                      throw new Error("Session read authority expired");
                    }
                  }),
                });
              },
            },
            (worker) => worker.execute({ type: "session.entry.read", input: { sessionKey } }),
          ),
        );
        await owner.revalidateTarget();
        assertCurrent();
      } finally {
        await execution.release();
      }
      owner.assertCurrent();
      return { entry, assertCurrent: owner.assertCurrent };
    },
    assertCallerCurrent,
  );
  loadedRead.assertCurrent();
  return loadedRead.entry;
}

type SessionStoreWorkerReadScope = {
  agentId: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
};

type SessionEntryWorkerRead = SessionStoreWorkerReadScope & {
  sessionKeys: readonly string[];
  lifecycleSessionKey?: string;
  projection?: "full" | "backing" | "sharing";
  includeMembers?: boolean;
  includeAuthorization?: boolean;
};

export type PreparedSessionEntryWorkerRead = {
  result: SessionExactEntriesWorkerResult;
  database: { agentId: string; path: string; env: NodeJS.ProcessEnv };
  assertCurrent: () => void;
};

/** Keep every discovered database and original admission alive through one synchronous consumer. */
export async function withSessionEntriesFromStoresInWorker<T>(
  inputs: readonly SessionEntryWorkerRead[],
  consume: (reads: readonly PreparedSessionEntryWorkerRead[]) => T,
): Promise<T> {
  const reads: PreparedSessionEntryWorkerRead[] = [];
  const enter = (index: number): Promise<T> => {
    const input = inputs[index];
    if (input) {
      return withSessionEntriesFromStoreInWorker(input, async (read) => {
        reads.push(read);
        try {
          return await enter(index + 1);
        } finally {
          reads.pop();
        }
      });
    }
    for (const read of reads) {
      read.assertCurrent();
    }
    let active = true;
    try {
      const result = consume(
        reads.map((read) => ({
          result: read.result,
          database: read.database,
          assertCurrent: () => {
            if (!active) {
              throw new Error("Session entry read consumer is no longer active");
            }
            read.assertCurrent();
          },
        })),
      );
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new Error("Session entry read consumers must remain synchronous");
      }
      return Promise.resolve(result);
    } finally {
      active = false;
    }
  };
  return enter(0);
}

/** The ordinary return API returns data, never a retained authority claim. */
export function readSessionEntriesFromStoreInWorker(input: SessionEntryWorkerRead) {
  return withSessionEntriesFromStoresInWorker([input], ([read]) => read!.result);
}

async function withSessionEntriesFromStoreInWorker<T>(
  input: SessionEntryWorkerRead,
  consume: (read: PreparedSessionEntryWorkerRead) => Promise<T>,
): Promise<T> {
  const request = {
    sessionKeys: [...new Set(input.sessionKeys)],
    lifecycleSessionKey: input.lifecycleSessionKey,
    projection: input.projection,
    includeMembers: input.includeMembers,
    includeAuthorization: input.includeAuthorization,
  };
  return withSessionStoreReaderInWorker(
    input,
    async (owner, database, continuation, assertCurrent) => {
      const result = await owner.readExactEntries({ ...request, env: database.env, continuation });
      assertCurrent();
      return consume({ result, database, assertCurrent });
    },
    input.projection === "backing",
  );
}

/** Return owned full entries only for expired cron runs; live deletion guards stay on the host. */
export async function readExpiredCronRunEntriesInWorker(
  input: SessionStoreWorkerReadScope & { updatedBefore: number },
) {
  const expiredCronRuns = {
    agentId: normalizeAgentId(input.agentId),
    updatedBefore: input.updatedBefore,
  };
  assertAgentDatabaseAdmitted(expiredCronRuns.agentId, { env: input.env });
  return withSessionStoreReaderInWorker(
    input,
    async (owner, database, _continuation, assertCurrent) => {
      const assertAdmitted = () => {
        assertAgentDatabaseAdmitted(expiredCronRuns.agentId, { env: database.env });
        assertAgentDatabaseAdmitted(database.agentId, { env: database.env });
      };
      assertAdmitted();
      const entries = await owner.readEntries({
        agentId: database.agentId,
        storePath: database.path,
        env: database.env,
        expiredCronRuns,
      });
      assertAdmitted();
      assertCurrent();
      return entries;
    },
  );
}

async function withSessionStoreReaderInWorker<T>(
  input: SessionStoreWorkerReadScope,
  read: (
    owner: SessionHistoryWorkerDatabase,
    database: PreparedSessionEntryWorkerRead["database"],
    continuation: CanonicalSessionReaderContinuation | undefined,
    assertCurrent: () => void,
  ) => Promise<T>,
  backing = false,
): Promise<T> {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const agentId = normalizeAgentId(input.agentId);
  const storePath = input.storePath;
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const captured = captureSessionStoreReadCandidate(target.path);
  const direct = target.agentId && captured.path === captured.physicalPath;
  const candidates = direct ? [captured] : captureSessionStoreReadCandidates(storePath);
  const native = backing
    ? retainOpenClawAgentDatabaseReadCandidates(
        candidates.flatMap((candidate) => [
          candidate,
          { ...candidate, path: candidate.physicalPath },
        ]),
        env,
      )
    : undefined;
  const continuations: Array<{
    path: string;
    owner: NonNullable<ReturnType<typeof captureCanonicalSessionReaderContinuation>>;
  }> = [];
  try {
    for (const database of native?.databases ?? []) {
      const owner = captureCanonicalSessionReaderContinuation(database);
      if (owner) {
        continuations.push({
          path: captureSessionStoreReadCandidate(database.path).physicalPath,
          owner,
        });
      }
    }
    const readDatabase = async (
      database: { agentId: string; path: string },
      assertRoute: () => void,
    ) => {
      const continuation = continuations.find((item) => item.path === database.path)?.owner;
      return withSessionHistoryWorkerDatabase({ ...database, env }, async (owner) => {
        let active = true;
        const assertCurrent = () => {
          if (!active) {
            throw new Error("Session entry read consumer is no longer active");
          }
          owner.assertCurrent();
          continuation?.assertCurrent();
          assertRoute();
        };
        try {
          return await read(
            owner,
            { ...database, env: { ...env } },
            continuation?.receipt,
            assertCurrent,
          );
        } finally {
          active = false;
        }
      });
    };
    if (direct && target.agentId) {
      resolveSqliteAgentId({ scopedAgentId: agentId, storeAgentId: target.agentId });
      return await readDatabase({ agentId: target.agentId, path: captured.physicalPath }, () =>
        assertSessionStoreReadCandidate(target.path, [captured]),
      );
    }
    return await withSessionStoreTarget(
      { agentId, storePath, env, candidates },
      (resolvedTarget, owner) => readDatabase(resolvedTarget.database, owner.assertCurrent),
    );
  } finally {
    for (const { owner } of continuations.toReversed()) {
      owner.release();
    }
    native?.release();
  }
}
