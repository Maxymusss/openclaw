import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";

// Exact affected tables from v2026.9.6 (ce5bbdc244ee937246cc1700d1b224d020c3b599),
// src/state/openclaw-state-schema.sql. No live schema or removed Task types.
export const RELEASED_OUTCOME_TABLES = `
  PRAGMA user_version = 18;
  CREATE TABLE subagent_runs (
    run_id TEXT NOT NULL PRIMARY KEY,
    child_session_key TEXT NOT NULL,
    controller_session_key TEXT,
    controller_store_path TEXT,
    requester_session_key TEXT NOT NULL,
    requester_store_path TEXT,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
  ) STRICT;
  CREATE TABLE task_runs (
    task_id TEXT NOT NULL PRIMARY KEY,
    runtime TEXT NOT NULL,
    task_kind TEXT,
    source_id TEXT,
    requester_session_key TEXT,
    owner_key TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    child_session_key TEXT,
    parent_flow_id TEXT,
    parent_task_id TEXT,
    agent_id TEXT,
    requester_agent_id TEXT,
    run_id TEXT,
    execution_owner_host TEXT,
    execution_owner_pid INTEGER,
    execution_owner_start_identity INTEGER,
    label TEXT,
    task TEXT NOT NULL,
    status TEXT NOT NULL,
    delivery_status TEXT NOT NULL,
    notify_policy TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    last_event_at INTEGER,
    cleanup_after INTEGER,
    tool_use_count INTEGER,
    last_tool_name TEXT,
    error TEXT,
    progress_summary TEXT,
    terminal_summary TEXT,
    terminal_outcome TEXT,
    detail_json TEXT
  ) STRICT;
`;

type FixtureRun = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  createdAt: number;
  [key: string]: unknown;
};

// Released subagent-registry.test.ts task-first cases (4183-4340) persist
// makeKilledRun before the native commit, after the Task result has committed.
export function makeReleasedKilledRun(overrides: Partial<FixtureRun> = {}): FixtureRun {
  return {
    runId: "physical-run",
    childSessionKey: "agent:worker:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "repair task-first completion",
    cleanup: "keep",
    createdAt: 1_000,
    sessionStartedAt: 1_000,
    generation: 1,
    execution: {
      status: "terminal",
      startedAt: 1_000,
      endedAt: 4_000,
      outcome: { status: "error", error: "manual kill" },
      lifecycleGeneration: "retained-lifecycle",
      suppressSessionEffects: true,
      restartRecovery: {
        sessionId: "retained-session",
        sessionMarker: "retained-marker",
        sessionLifecycleRevision: "retained-revision",
        idempotencyKey: "retained-recovery-receipt",
        phase: "consumed",
      },
    },
    completion: { required: true },
    endedReason: "subagent-killed",
    suppressAnnounceReason: "killed",
    killReconciliation: { killedAt: 4_000 },
    cleanupHandled: true,
    cleanupCompletedAt: 4_000,
    browserCleanupDispatchedAt: 4_000,
    delivery: { status: "pending", generation: 3, queueId: "retained-queue" },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 2,
      batchRunIds: ["physical-run"],
      progressOperationId: "retained-presentation-receipt",
    },
    ...overrides,
  };
}

export function insertReleasedRun(
  db: DatabaseSync,
  run = makeReleasedKilledRun(),
  parentEnvelope = false,
): void {
  db.prepare(
    `INSERT INTO subagent_runs (
       run_id, child_session_key, requester_session_key, controller_session_key,
       requester_store_path, controller_store_path, created_at, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.runId,
    run.childSessionKey,
    run.requesterSessionKey,
    "agent:controller:main",
    "/fixture/requester.sqlite",
    "/fixture/controller.sqlite",
    run.createdAt,
    JSON.stringify(
      parentEnvelope
        ? { parentCompletion: { ...run, completionTarget: "parent" }, envelope: "kept" }
        : run,
    ),
  );
}

export function insertReleasedTask(
  db: DatabaseSync,
  overrides: Partial<{
    taskId: string;
    runId: string | null;
    childSessionKey: string;
    requesterSessionKey: string;
    runtime: string;
    status: string;
    createdAt: number;
    startedAt: number | null;
    endedAt: number | null;
    progressSummary: string | null;
    terminalSummary: string | null;
    error: string | null;
  }> = {},
): void {
  const task = {
    taskId: "task-row",
    runId: "physical-run",
    childSessionKey: "agent:worker:subagent:child",
    requesterSessionKey: "agent:main:main",
    runtime: "subagent",
    status: "succeeded",
    createdAt: 1_000,
    startedAt: 1_000,
    endedAt: 5_000,
    progressSummary: "durable final result",
    terminalSummary: "terminal fallback",
    error: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO task_runs (
       task_id, run_id, runtime, requester_session_key, owner_key, scope_kind,
       child_session_key, task, status, delivery_status, notify_policy,
       created_at, started_at, ended_at, progress_summary, terminal_summary, error
     ) VALUES (?, ?, ?, ?, ?, 'session', ?, 'repair task-first completion', ?,
       'pending', 'done_only', ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.taskId,
    task.runId,
    task.runtime,
    task.requesterSessionKey,
    task.requesterSessionKey,
    task.childSessionKey,
    task.status,
    task.createdAt,
    task.startedAt,
    task.endedAt,
    task.progressSummary,
    task.terminalSummary,
    task.error,
  );
}

export function readOutcomePayload(
  db: DatabaseSync,
  runId = "physical-run",
): Record<string, unknown> {
  const row = db.prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?").get(runId);
  const payload =
    typeof row?.payload_json === "string" ? safeParseJsonRecord(row.payload_json) : null;
  if (!payload) {
    throw new Error("Expected fixture native payload");
  }
  return payload;
}

export function outcomeDatabaseSnapshot(db: DatabaseSync) {
  return {
    schema: db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all(),
    version: db.prepare("PRAGMA user_version").get(),
    tasks: db.prepare("SELECT * FROM task_runs ORDER BY task_id").all(),
    runs: db.prepare("SELECT * FROM subagent_runs ORDER BY run_id").all(),
  };
}
