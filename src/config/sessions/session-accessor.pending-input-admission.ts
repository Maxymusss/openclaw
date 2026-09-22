import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
  hasSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  readSessionInputCompletion,
  isFinalInputCompletion,
  readSessionPendingInputByKey,
  type SessionPendingInputRow,
} from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";

type PendingInputAdmissionScope = Pick<
  ResolvedTranscriptScope,
  "sessionKey" | "sessionId" | "agentId"
>;
export type PendingInputAdmissionRead = {
  scope: PendingInputAdmissionScope;
  idempotencyKey: string;
  trackCompletion: boolean;
};
export function readPendingInputAdmission(
  database: OpenClawAgentDatabase,
  input: PendingInputAdmissionRead,
) {
  if (
    readSessionEntryRow(database, input.scope.sessionKey)?.entry.sessionId !== input.scope.sessionId
  ) {
    return undefined;
  }
  if (input.trackCompletion) {
    ensureSessionInputCompletionsSchema(database.db);
  }
  const bytes = hasSessionPendingInputsSchema(database.db)
    ? executeSqliteQueryTakeFirstSync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_pending_inputs")
          .select((eb) => eb.fn<number>("octet_length", ["message_json"]).as("bytes"))
          .where("session_key", "=", input.scope.sessionKey)
          .where("session_id", "=", input.scope.sessionId)
          .where("idempotency_key", "=", input.idempotencyKey),
      )?.bytes
    : undefined;
  if (bytes !== undefined && bytes > MAX_PAYLOAD_BYTES) {
    throw new Error("Stored pending input exceeds the Gateway payload limit");
  }
  const existing = readSessionPendingInputByKey(database, input.scope, input.idempotencyKey);
  const previous = input.trackCompletion
    ? readSessionInputCompletion(database, { ...input.scope, idempotencyKey: input.idempotencyKey })
    : undefined;
  return {
    existing,
    previous,
    committed:
      existing || (previous && isFinalInputCompletion(previous.outcome))
        ? undefined
        : readTranscriptMessageByScopedIdempotencyKey(
            database,
            input.scope,
            input.idempotencyKey,
            "scan",
          ),
  };
}
export type PendingInputAdmissionInsert = PendingInputAdmissionRead & {
  inputId: string;
  runId: string;
  requestHash: string;
  messageJson: string;
  lifecycleGeneration: string;
  existing?: SessionPendingInputRow;
};
export function insertPendingInputAdmission(
  database: OpenClawAgentDatabase,
  input: PendingInputAdmissionInsert,
): boolean {
  const { scope, existing } = input;
  if (readSessionEntryRow(database, scope.sessionKey)?.entry.sessionId !== scope.sessionId) {
    return false;
  }
  ensureSessionPendingInputsSchema(database.db);
  if (input.trackCompletion) {
    ensureSessionInputCompletionsSchema(database.db);
    const completed = readSessionInputCompletion(database, {
      ...scope,
      idempotencyKey: input.idempotencyKey,
    });
    if (
      completed &&
      (completed.request_hash !== input.requestHash ||
        completed.run_id !== input.runId ||
        completed.outcome.reason === "completed" ||
        (completed.outcome.reason === "cancelled" && completed.outcome.stopReason !== "restart"))
    ) {
      return false;
    }
  }
  if (existing) {
    const result = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_pending_inputs")
        .set({ state: "queued", lifecycle_generation: input.lifecycleGeneration })
        .where("input_id", "=", input.inputId)
        .where("session_key", "=", scope.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("run_id", "=", input.runId)
        .where("lifecycle_generation", "=", existing.lifecycle_generation)
        .where("request_hash", "=", input.requestHash)
        .where("message_json", "=", existing.message_json)
        .where("state", "=", existing.state)
        .where("consumed_event_id", "is", null),
    );
    return result.numAffectedRows === 1n;
  }
  if (
    readSessionPendingInputByKey(database, scope, input.idempotencyKey) ||
    readTranscriptMessageByScopedIdempotencyKey(database, scope, input.idempotencyKey, "scan")
  ) {
    return false;
  }
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db).insertInto("session_pending_inputs").values({
      input_id: input.inputId,
      session_key: scope.sessionKey,
      session_id: scope.sessionId,
      idempotency_key: input.idempotencyKey,
      run_id: input.runId,
      request_hash: input.requestHash,
      message_json: input.messageJson,
      lifecycle_generation: input.lifecycleGeneration,
      state: "queued",
      accepted_at: Date.now(),
    }),
  );
  return true;
}
