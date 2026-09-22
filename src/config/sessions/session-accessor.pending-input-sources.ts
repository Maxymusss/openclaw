import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { readSessionPendingSourceNative } from "./session-accessor.pending-input-sources.native.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { prepareCurrentSessionPendingInputDedupeRecovery } from "./session-accessor.sqlite-pending-inputs.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { SessionPendingSourceWorkerInput } from "./session-transcript-worker.types.js";

type PendingInputScope = SessionAccessScope & { agentId: string; sessionId: string };

async function readSource(
  scope: PendingInputScope,
  request: SessionPendingSourceWorkerInput["request"],
) {
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const resolved = resolveSqliteTranscriptScope({ ...scope, env });
  const options = toDatabaseOptions(resolved);
  const path = resolveOpenClawAgentSqlitePath(options);
  const captured = { ...scope, env, storePath: path };
  if (isIncognitoOpenClawAgentSqlitePath(path, options)) {
    // Incognito SQLite is process-local and retains its existing native owner.
    return readSessionPendingSourceNative(captured, request);
  }
  return withSessionHistoryWorkerDatabase(options, (owner) =>
    owner.readPendingSource({ scope: captured, request }),
  );
}

/** Async evidence is not authority; the returned callback consumes the current host owner once. */
export async function prepareSessionPendingInputDedupeRecovery(
  scope: PendingInputScope,
  runId: string,
): Promise<() => boolean> {
  const resolved = resolveSqliteTranscriptScope(scope);
  const prepared = prepareCurrentSessionPendingInputDedupeRecovery(
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
    resolved,
    runId,
  );
  if (!prepared) {
    return () => false;
  }
  const evidence = await readSource(scope, {
    kind: "dedupe",
    idempotencyKey: `${runId}:user`,
    ...prepared.evidence,
  });
  return () => prepared.consume(evidence === true);
}

export async function hasRetainedSessionPendingInput(
  scope: PendingInputScope,
  source: { idempotencyKey: string; requestFingerprint: string },
): Promise<boolean> {
  return (await readSource(scope, { kind: "retained", ...source })) === true;
}

export async function readSessionSubmittedInput(
  scope: PendingInputScope,
  idempotencyKey: string,
): Promise<PersistedUserTurnMessage | undefined> {
  try {
    const value = await readSource(scope, { kind: "submitted", idempotencyKey });
    return typeof value === "boolean" ? undefined : value;
  } catch {
    // An unavailable reader supplies no proof; never fall back to host SQLite.
    return undefined;
  }
}
