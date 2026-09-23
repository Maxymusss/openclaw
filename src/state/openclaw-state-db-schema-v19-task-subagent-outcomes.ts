import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asDateTimestampMs, asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

type LegacyRun = {
  physicalRunId: string;
  runId: string | undefined;
  childSessionKey: string | undefined;
  requesterSessionKey: string;
  createdAt: number | undefined;
  originalJson: string;
  stored: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
};

type LegacyTask = {
  runId: string | undefined;
  runtime: unknown;
  childSessionKey: string | undefined;
  requesterSessionKey: unknown;
  createdAt: number | undefined;
  startedAt: number | undefined;
  endedAt: number | undefined;
  status: unknown;
  error: string | undefined;
  resultText: string | null;
};

function groupBy<T>(items: T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (value !== undefined) {
      const group = groups.get(value);
      if (group) {
        group.push(item);
      } else {
        groups.set(value, [item]);
      }
    }
  }
  return groups;
}

function readRuns(db: DatabaseSync): LegacyRun[] {
  return /* sqlite-allow-raw -- v19 migration reads released native identity/payload bytes. */ db
    .prepare(
      "SELECT run_id, child_session_key, requester_session_key, created_at, payload_json FROM subagent_runs",
    )
    .all()
    .map((row) => {
      if (
        typeof row.run_id !== "string" ||
        typeof row.requester_session_key !== "string" ||
        typeof row.payload_json !== "string"
      ) {
        throw new Error("Cannot migrate legacy task outcomes: invalid native run identity");
      }
      const stored = safeParseJsonRecord(row.payload_json) ?? null;
      const parentCompletion = asNullableRecord(stored?.parentCompletion);
      const payload = parentCompletion?.completionTarget === "parent" ? parentCompletion : stored;
      return {
        physicalRunId: row.run_id,
        runId: normalizeOptionalString(row.run_id),
        childSessionKey: normalizeOptionalString(row.child_session_key),
        requesterSessionKey: row.requester_session_key,
        createdAt: asDateTimestampMs(row.created_at),
        originalJson: row.payload_json,
        stored,
        payload,
      };
    });
}

function readTasks(db: DatabaseSync): LegacyTask[] {
  // Migration SQL deliberately uses the released columns, not the generated DB
  // interface: v19 removes this table from every runtime storage contract.
  return /* sqlite-allow-raw -- Historical Task columns have no post-v19 Kysely type. */ db
    .prepare(
      `SELECT run_id, runtime, child_session_key, requester_session_key, created_at,
              started_at, ended_at, status, error, progress_summary, terminal_summary
         FROM task_runs`,
    )
    .all()
    .map((row) => ({
      runId: normalizeOptionalString(row.run_id),
      runtime: row.runtime,
      childSessionKey: normalizeOptionalString(row.child_session_key),
      requesterSessionKey: row.requester_session_key,
      createdAt: asDateTimestampMs(row.created_at),
      startedAt: asDateTimestampMs(row.started_at),
      endedAt: asDateTimestampMs(row.ended_at),
      status: row.status,
      error: typeof row.error === "string" ? row.error : undefined,
      // This is the released sweep-kill precedence, including an empty primary.
      resultText:
        typeof row.progress_summary === "string"
          ? row.progress_summary
          : typeof row.terminal_summary === "string"
            ? row.terminal_summary
            : null,
    }));
}

function hasNewerOrUncertainGeneration(run: LegacyRun, siblings: LegacyRun[]): boolean {
  const generation = asFiniteNumber(run.payload?.generation) ?? 0;
  return siblings.some((sibling) => {
    if (sibling === run) {
      return false;
    }
    // Released sweep-kill recovered task-first results only for the latest
    // generation. Equal-time rows are ambiguous, not a lexicographic owner.
    return (
      !sibling.payload ||
      (Object.hasOwn(sibling.payload, "generation") &&
        asFiniteNumber(sibling.payload.generation) === undefined) ||
      sibling.createdAt === undefined ||
      run.createdAt === undefined ||
      sibling.createdAt >= run.createdAt ||
      (asFiniteNumber(sibling.payload.generation) ?? 0) > generation
    );
  });
}

function recoverOutcome(run: LegacyRun, task: LegacyTask): boolean {
  const { payload, createdAt } = run;
  const execution = asNullableRecord(payload?.execution);
  const completion = asNullableRecord(payload?.completion);
  const kill = asNullableRecord(payload?.killReconciliation);
  const killedAt = asDateTimestampMs(kill?.killedAt);
  const executionEndedAt = asDateTimestampMs(execution?.endedAt);
  if (
    !payload ||
    !execution ||
    !completion ||
    typeof completion.required !== "boolean" ||
    !kill ||
    killedAt === undefined ||
    createdAt === undefined ||
    killedAt < createdAt ||
    payload.endedReason !== "subagent-killed" ||
    execution.status !== "terminal" ||
    asNullableRecord(execution.outcome)?.status !== "error" ||
    executionEndedAt === undefined ||
    executionEndedAt > killedAt ||
    (Object.hasOwn(execution, "startedAt") &&
      asDateTimestampMs(execution.startedAt) === undefined) ||
    (Object.hasOwn(payload, "sessionStartedAt") &&
      asDateTimestampMs(payload.sessionStartedAt) === undefined) ||
    Object.hasOwn(kill, "supersededAt") ||
    Object.hasOwn(payload, "killIntent") ||
    Object.hasOwn(payload, "terminalOwner") ||
    Object.hasOwn(payload, "pauseReason") ||
    payload.suppressAnnounceReason === "steer-restart" ||
    task.runtime !== "subagent" ||
    task.childSessionKey !== run.childSessionKey ||
    task.requesterSessionKey !== run.requesterSessionKey ||
    task.createdAt === undefined ||
    task.endedAt === undefined ||
    (task.status !== "succeeded" && task.status !== "failed" && task.status !== "timed_out")
  ) {
    return false;
  }
  const sessionStartedAt = asDateTimestampMs(payload.sessionStartedAt) ?? createdAt;
  const startedAt = asDateTimestampMs(execution.startedAt) ?? task.startedAt;
  if (
    sessionStartedAt > createdAt ||
    task.createdAt < sessionStartedAt ||
    task.createdAt > task.endedAt ||
    task.createdAt > killedAt ||
    task.endedAt < createdAt ||
    (startedAt !== undefined && (startedAt < createdAt || task.endedAt < startedAt))
  ) {
    return false;
  }

  // v2026.9.6 replay used the current native start, not the retained task's
  // original steer start, when applying its explicit timeout deadline.
  let endedAt = task.endedAt;
  let status = task.status === "succeeded" ? "ok" : task.status === "failed" ? "error" : "timeout";
  const seconds = asFiniteNumber(payload.runTimeoutSeconds);
  const durationMs = seconds === undefined ? 0 : Math.floor(seconds) * 1_000;
  const deadlineStart = startedAt ?? (payload.collect ? undefined : createdAt);
  const deadline = deadlineStart === undefined ? undefined : deadlineStart + durationMs;
  if (
    Number.isSafeInteger(durationMs) &&
    durationMs > 0 &&
    deadline !== undefined &&
    Number.isSafeInteger(deadline) &&
    asDateTimestampMs(deadline) !== undefined &&
    endedAt > deadline
  ) {
    endedAt = deadline;
    status = "timeout";
  }
  payload.execution = {
    ...execution,
    ...(startedAt === undefined ? {} : { startedAt }),
    endedAt,
    outcome: {
      status,
      ...(status === "error" && task.error !== undefined ? { error: task.error } : {}),
      ...(startedAt === undefined ? {} : { startedAt, elapsedMs: endedAt - startedAt }),
      endedAt,
    },
  };
  payload.endedReason = status === "error" ? "subagent-error" : "subagent-complete";

  // Native capture wins even when it recorded null, an empty reply, or explicit
  // terminal silence. Frozen delivery results must be promoted before this step.
  const hasNativeCapture = [
    "terminalReply",
    "resultText",
    "capturedAt",
    "fallbackResultText",
    "fallbackCapturedAt",
  ].some((field) => Object.hasOwn(completion, field));
  if (!hasNativeCapture) {
    completion.resultText = task.resultText;
    completion.capturedAt = task.endedAt;
  }
  // Retire only the contradicted provisional kill. Do not rearm delivery, clear
  // receipts/cleanup facts, mint authority, or rewrite execution lifecycle fences.
  if (kill.suppressTaskDelivery === true) {
    payload.suppressCompletionDelivery = true;
  }
  delete payload.killReconciliation;
  if (payload.suppressAnnounceReason === "killed") {
    delete payload.suppressAnnounceReason;
  }
  return true;
}

/**
 * Preserve the v2026.9.6 registry/subagent-registry-sweep-kill.ts task-first
 * crash window (ce5bbdc244ee937246cc1700d1b224d020c3b599) before v19 drops task_runs.
 * Call inside the schema owner's transaction, AFTER v13 JSON canonicalization,
 * legacy root execution repair, and frozen-result promotion,
 * BEFORE dropping Task tables. This neither imports a registry nor delivers work.
 * Returns the number of native payloads updated; the caller owns commit/rollback.
 */
export function migrateLegacyTaskSubagentOutcomes(db: DatabaseSync): number {
  if (!db.isTransaction) {
    throw new Error("Legacy task outcome migration requires the schema migration transaction");
  }
  if (!tableExists(db, "task_runs") || !tableExists(db, "subagent_runs")) {
    return 0;
  }
  if (tableHasColumn(db, "subagent_runs", "task")) {
    throw new Error("Legacy task outcomes must migrate after v13 native JSON canonicalization");
  }
  const runs = readRuns(db);
  const tasks = readTasks(db);
  const tasksByRun = groupBy(tasks, (task) => task.runId);
  const tasksByChild = groupBy(
    tasks.filter((task) => task.runtime === "subagent"),
    (task) => task.childSessionKey,
  );
  const runsByChild = groupBy(runs, (run) => run.childSessionKey);
  const claims = groupBy(
    runs,
    (run) => normalizeOptionalString(run.payload?.taskRunId) ?? run.runId,
  );
  const update =
    /* sqlite-allow-raw -- v19 updates canonical native payloads before retiring Task DDL. */ db.prepare(
      "UPDATE subagent_runs SET payload_json = ? WHERE run_id = ? AND payload_json = ?",
    );
  let migrated = 0;
  for (const run of runs) {
    const { payload, stored, runId, childSessionKey, createdAt } = run;
    if (
      !payload ||
      !stored ||
      !runId ||
      !childSessionKey ||
      !normalizeOptionalString(run.requesterSessionKey) ||
      (Object.hasOwn(payload, "generation") && asFiniteNumber(payload.generation) === undefined) ||
      createdAt === undefined ||
      normalizeOptionalString(payload.runId) !== runId ||
      normalizeOptionalString(payload.childSessionKey) !== childSessionKey ||
      payload.requesterSessionKey !== run.requesterSessionKey ||
      payload.createdAt !== createdAt
    ) {
      continue;
    }
    const siblings = runsByChild.get(childSessionKey) ?? [];
    if (hasNewerOrUncertainGeneration(run, siblings)) {
      continue;
    }
    const explicitBinding = Object.hasOwn(payload, "taskRunId");
    const binding = explicitBinding ? normalizeOptionalString(payload.taskRunId) : runId;
    let matches = binding === undefined ? [] : (tasksByRun.get(binding) ?? []);
    if (!explicitBinding && matches.length === 0) {
      const sessionStartedAt = asDateTimestampMs(payload.sessionStartedAt);
      const childTasks = tasksByChild.get(childSessionKey) ?? [];
      const childTask = childTasks.length === 1 ? childTasks[0] : undefined;
      // v2026.6.34 steer replaced runId but retained sessionStartedAt. Retain
      // only its unique task/child/requester/window proof, without persisting
      // another task binding that the post-v19 runtime would have to maintain.
      if (
        siblings.length === 1 &&
        childTask !== undefined &&
        asNullableRecord(payload.completion)?.required === true &&
        sessionStartedAt !== undefined &&
        sessionStartedAt < createdAt &&
        childTask.createdAt !== undefined &&
        childTask.createdAt >= sessionStartedAt &&
        childTask.createdAt <= createdAt
      ) {
        matches = childTasks;
      }
    }
    const task = matches.length === 1 ? matches[0] : undefined;
    if (
      !task?.runId ||
      tasksByRun.get(task.runId)?.length !== 1 ||
      (claims.get(task.runId) ?? []).some((claim) => claim !== run) ||
      !recoverOutcome(run, task)
    ) {
      continue;
    }
    if (
      Number(update.run(JSON.stringify(stored), run.physicalRunId, run.originalJson).changes) !== 1
    ) {
      throw new Error("Native run changed during legacy task outcome migration");
    }
    migrated += 1;
  }
  return migrated;
}
