import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import {
  foregroundRunStoppedNoticeKey,
  type SessionForegroundRun,
  type SessionForegroundStoppedReceipt,
} from "./session-foreground-run.js";

/** Indexed retained evidence; absence is not proof that an attempted request is fresh. */
export function readForegroundStoppedReceiptInWorker(params: {
  database: OpenClawAgentDatabaseOptions;
  scope: SessionAccessScope;
  expected: Pick<SessionForegroundRun, "runId" | "sessionId" | "lifecycleRevision">;
}): SessionForegroundStoppedReceipt {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(database.db, (): SessionForegroundStoppedReceipt => {
        const resolved = resolveSqliteTranscriptScope({
          ...params.scope,
          sessionId: params.expected.sessionId,
        });
        const entry = readSessionEntryRow(database, resolved.sessionKey)?.entry;
        if (
          !entry ||
          entry.sessionId !== params.expected.sessionId ||
          (entry.lifecycleRevision ?? null) !== params.expected.lifecycleRevision
        ) {
          return { kind: "unavailable" };
        }
        const noticeKey = foregroundRunStoppedNoticeKey(params.expected);
        const found = readTranscriptMessageByScopedIdempotencyKey(
          database,
          resolved,
          noticeKey,
          undefined,
        );
        if (!found) {
          return { kind: "absent" };
        }
        const message = found.message;
        const metadata =
          isRecord(message) && isRecord(message["__openclaw"]) ? message["__openclaw"] : undefined;
        const stopped =
          metadata && isRecord(metadata.foregroundStopped) ? metadata.foregroundStopped : undefined;
        return isRecord(message) &&
          message.role === "assistant" &&
          message.idempotencyKey === noticeKey &&
          message.provider === "openclaw" &&
          message.model === "gateway-injected" &&
          metadata?.runId === params.expected.runId &&
          stopped?.sessionId === params.expected.sessionId &&
          stopped?.lifecycleRevision === params.expected.lifecycleRevision
          ? { kind: "stopped" }
          : { kind: "unavailable" };
      }),
    params.database,
  );
  return result.found ? result.value : { kind: "unavailable" };
}
