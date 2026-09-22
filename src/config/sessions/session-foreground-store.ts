import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { withOpenClawAgentDatabaseAsync } from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { discardCommittedSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type {
  SessionForegroundRun,
  SessionForegroundRecoveryExpectation,
} from "./session-foreground-run.js";
import type { SessionForegroundWorkerOperations } from "./session-foreground-store.worker.js";

/** Capture the database owner before yielding; the worker also fences the exact row and writer. */
export async function writeSessionForegroundRun(params: {
  kind: "admit" | "stop";
  scope: SessionAccessScope;
  admission: SessionForegroundRun;
  expectedWriterRunId: string | null;
  expectedRecovery: SessionForegroundRecoveryExpectation;
  assertCurrent: () => void;
}): Promise<boolean> {
  const resolved = resolveSqliteScope(params.scope);
  const env = cloneEnvWithPlatformSemantics(resolved.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = { ...toDatabaseOptions(resolved), env };
  const path = resolveOpenClawAgentSqlitePath(options);
  if (isIncognitoOpenClawAgentSqlitePath(path, options)) {
    throw new Error("Foreground restart custody requires a durable session store");
  }
  const scope = {
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    storePath: path,
    env: { OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR },
  };
  const input = structuredClone({
    scope,
    admission: params.admission,
    expectedWriterRunId: params.expectedWriterRunId,
    expectedRecovery: params.expectedRecovery,
    gatewayLifecycleGeneration: getAgentEventLifecycleGeneration(),
  });
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const assertCurrent = () => {
    execution.assertCurrent();
    params.assertCurrent();
  };
  try {
    return await runOpenClawAgentWriteAdmission(
      options,
      () =>
        withOpenClawAgentDatabaseAsync(
          options,
          async (database) => {
            assertCurrent();
            const worker =
              await openOpenClawAgentSqliteWorkerStore<SessionForegroundWorkerOperations>(
                options,
                database.db,
                {
                  moduleUrl: resolveRuntimeWorkerUrl(
                    runtimeProcessEntrypoints.sessionForegroundStore,
                  ),
                  input: undefined,
                },
              );
            let dispatched = false;
            try {
              return await worker.run(async (operation) => {
                dispatched = true;
                const result = await operation.execute({ type: params.kind, input });
                if (result.changed) {
                  discardCommittedSessionEntryCache(database.db);
                  sessionChanges.emit({ ...scope, factsInvalidated: true });
                }
                if (result.notice?.appended) {
                  emitSessionTranscriptUpdate({
                    target: { ...scope, sessionId: input.admission.sessionId },
                    lifecycleRevision: input.admission.lifecycleRevision ?? undefined,
                    runId: input.admission.runId,
                    message: result.notice.message,
                    messageId: result.notice.messageId,
                    messageSeq: result.notice.anchor?.rawSeq,
                  });
                }
                return result.changed;
              }, assertCurrent);
            } catch (error) {
              if (dispatched) {
                // An unknown commit outcome must be re-read, never replayed as fresh admission.
                discardCommittedSessionEntryCache(database.db);
                sessionChanges.emit({ ...scope, factsInvalidated: true });
              }
              throw error;
            } finally {
              await worker.close();
            }
          },
          assertCurrent,
        ),
      true,
    );
  } finally {
    await execution.release();
  }
}
