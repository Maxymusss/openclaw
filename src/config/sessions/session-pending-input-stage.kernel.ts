import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  readSessionInputCompletion,
  readSessionPendingInputByKey,
} from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import type {
  PendingInputStageInspection,
  PendingInputStageRead,
  PendingInputStageWrite,
} from "./session-pending-input-stage.js";

type Database = Pick<OpenClawAgentDatabase, "db" | "path" | "agentId">;
export function inspectPendingInputStage(
  database: Database,
  input: PendingInputStageRead,
): PendingInputStageInspection {
  const { scope, idempotencyKey } = input;
  const entry = readSessionEntryRow(database, scope.sessionKey)?.entry;
  if (entry?.sessionId !== scope.sessionId) return { entry };
  const existing = readSessionPendingInputByKey(database, scope, idempotencyKey);
  if (input.trackCompletion) ensureSessionInputCompletionsSchema(database.db);
  const previous = input.trackCompletion
    ? readSessionInputCompletion(database, { ...scope, idempotencyKey })
    : undefined;
  return { entry, existing, previous };
}

export function readPendingInputStageTranscript(database: Database, input: PendingInputStageRead) {
  return readTranscriptMessageByScopedIdempotencyKey(
    database,
    input.scope,
    input.idempotencyKey,
    "scan",
  );
}

/** The caller supplies the transaction and live admission; this kernel never retries a write. */
export function commitPendingInputStage(
  database: Database,
  input: PendingInputStageWrite,
): boolean {
  const { scope, expected, inputId, runId, requestHash, messageJson, lifecycleGeneration } = input;
  const current = {
    ...inspectPendingInputStage(database, input),
    committed: readPendingInputStageTranscript(database, input),
  };
  if (
    current.entry?.sessionId !== scope.sessionId ||
    current.entry.lifecycleRevision !== expected.entry?.lifecycleRevision
  )
    return false;
  if (
    !isDeepStrictEqual(current.existing, expected.existing) ||
    !isDeepStrictEqual(current.previous, expected.previous) ||
    !isDeepStrictEqual(current.committed, expected.committed)
  ) {
    throw new Error("Pending input changed during preparation; retry the request");
  }
  const existing = expected.existing;
  ensureSessionPendingInputsSchema(database.db);
  if (existing) {
    const result = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_pending_inputs")
        .set({ state: "queued", lifecycle_generation: lifecycleGeneration })
        .where("input_id", "=", inputId)
        .where("session_key", "=", scope.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("run_id", "=", runId)
        .where("lifecycle_generation", "=", existing.lifecycle_generation)
        .where("request_hash", "=", requestHash)
        .where("message_json", "=", existing.message_json)
        .where("state", "=", existing.state)
        .where("consumed_event_id", "is", null),
    );
    return result.numAffectedRows === 1n;
  }
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db).insertInto("session_pending_inputs").values({
      input_id: inputId,
      session_key: scope.sessionKey,
      session_id: scope.sessionId,
      idempotency_key: input.idempotencyKey,
      run_id: runId,
      request_hash: requestHash,
      message_json: messageJson,
      lifecycle_generation: lifecycleGeneration,
      state: "queued",
      accepted_at: Date.now(),
    }),
  );
  return true;
}
