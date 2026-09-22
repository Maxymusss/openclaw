import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { InternalSessionEntry } from "./types.js";

/** Negative recovery fact written with accepted input; this never grants execution authority. */
export type SessionForegroundRun = Readonly<{
  runId: string;
  sessionId: string;
  lifecycleRevision: string | null;
  gatewayLifecycleGeneration: string;
  deadlineAt: number;
}>;

export type SessionForegroundRunState =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "bound"; admission: SessionForegroundRun };

export type SessionForegroundStoppedReceipt =
  | { kind: "stopped" }
  | { kind: "absent" }
  | { kind: "unavailable" };

export type SessionForegroundRecoveryExpectation = Pick<
  InternalSessionEntry,
  "mainRestartRecovery" | "restartRecoveryRuns"
>;

/** Absence is an expected fact too: a newly acquired recovery claim must win. */
export function captureForegroundRecoveryExpectation(
  entry: SessionForegroundRecoveryExpectation | undefined,
): SessionForegroundRecoveryExpectation {
  return structuredClone({
    mainRestartRecovery: entry?.mainRestartRecovery,
    restartRecoveryRuns: entry?.restartRecoveryRuns,
  });
}

/** Unknown or malformed persisted restrictions must not become legacy resumable work. */
export function readSessionForegroundRun(entry: InternalSessionEntry): SessionForegroundRunState {
  if (!Object.hasOwn(entry, "foregroundRun")) {
    return { kind: "absent" };
  }
  const value: unknown = entry.foregroundRun;
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    !value.runId.trim() ||
    value.sessionId !== entry.sessionId ||
    value.lifecycleRevision !== (entry.lifecycleRevision ?? null) ||
    typeof value.gatewayLifecycleGeneration !== "string" ||
    !value.gatewayLifecycleGeneration.trim() ||
    typeof value.deadlineAt !== "number" ||
    !Number.isFinite(value.deadlineAt)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "bound",
    admission: {
      runId: value.runId,
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision ?? null,
      gatewayLifecycleGeneration: value.gatewayLifecycleGeneration,
      deadlineAt: value.deadlineAt,
    },
  };
}

export function foregroundRunStoppedNoticeKey(
  admission: Pick<SessionForegroundRun, "runId">,
): string {
  return `foreground-run:${admission.runId}:stopped-notice`;
}
