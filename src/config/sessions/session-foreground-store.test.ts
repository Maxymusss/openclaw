import { expect, it } from "vitest";
import { claimMainSessionRecoveryOwner } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { projectPublicSessionEntry } from "./session-entry-projection.js";
import { readForegroundStoppedReceiptInWorker } from "./session-foreground-receipt.worker.js";
import {
  captureForegroundRecoveryExpectation,
  type SessionForegroundRun,
} from "./session-foreground-run.js";
import { writeSessionForegroundRun } from "./session-foreground-store.js";
import { bindSqliteWorkerBackend } from "./session-foreground-store.worker.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

const scope = { agentId: "main", sessionKey: "agent:main:foreground" };
const admission: SessionForegroundRun = {
  runId: "foreground-turn",
  sessionId: "foreground-session",
  lifecycleRevision: "foreground-revision",
  gatewayLifecycleGeneration: "previous-gateway-generation",
  deadlineAt: 8_000_000_000_000,
};
const expected = {
  runId: admission.runId,
  sessionId: admission.sessionId,
  lifecycleRevision: admission.lifecycleRevision,
};
const assertCurrent = () => {};
const expectedRecovery = captureForegroundRecoveryExpectation(undefined);

async function createSession() {
  await upsertSessionEntryCore(scope, {
    sessionId: admission.sessionId,
    lifecycleRevision: admission.lifecycleRevision ?? undefined,
    updatedAt: 1,
  });
}

it("retains the private foreground marker in the canonical user-turn receipt", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await createSession();
    await writeSessionForegroundRun({
      kind: "admit",
      scope,
      admission,
      expectedWriterRunId: null,
      expectedRecovery,
      assertCurrent,
    });
    const recorder = createUserTurnTranscriptRecorder({
      target: {
        ...scope,
        sessionId: admission.sessionId,
        expectedSessionId: admission.sessionId,
        sessionEntry: undefined,
      },
      input: { text: "one foreground turn", idempotencyKey: "foreground-receipt:user" },
    });
    const persisted = await recorder.persistFallback();
    if (!persisted?.sessionEntry) {
      throw new Error("Expected the canonical user-turn session receipt");
    }
    expect(persisted.appended).toBe(true);
    expect(persisted.sessionEntry.foregroundRun).toEqual(admission);
    expect(loadSessionEntry(scope)?.foregroundRun).toEqual(admission);
    expect(projectPublicSessionEntry(persisted.sessionEntry)).not.toHaveProperty("foregroundRun");
  });
});

it("stops only the restricted turn, retains indexed notice beyond terminal ID eviction, and accepts a new turn", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await createSession();
    const request = {
      scope,
      admission,
      expectedWriterRunId: null,
      expectedRecovery,
      assertCurrent,
    };
    expect(await writeSessionForegroundRun({ ...request, kind: "admit" })).toBe(true);
    expect(loadSessionEntry(scope)).toMatchObject({ foregroundRun: admission, status: "running" });
    expect(await writeSessionForegroundRun({ ...request, kind: "stop" })).toBe(true);
    expect(loadSessionEntry(scope)).toMatchObject({
      status: "interrupted",
      lastRunId: admission.runId,
      restartRecoveryTerminalRunIds: [admission.runId],
    });
    expect(loadSessionEntry(scope)?.mainRestartRecovery).toBeUndefined();
    await patchSessionEntryCore(scope, () => ({
      restartRecoveryTerminalRunIds: Array.from({ length: 64 }, (_, i) => `later-${i}`),
    }));
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    expect(
      await withSessionHistoryWorkerDatabase(
        { agentId: scope.agentId, path: database.path },
        (owner) => owner.readForegroundStoppedReceipt({ scope, expected }),
      ),
    ).toEqual({ kind: "stopped" });
    expect(
      await withSessionHistoryWorkerDatabase(
        { agentId: scope.agentId, path: database.path },
        (owner) =>
          owner.readForegroundStoppedReceipt({
            scope,
            expected: { ...expected, lifecycleRevision: "replacement" },
          }),
      ),
    ).toEqual({ kind: "unavailable" });
    await expect(writeSessionForegroundRun({ ...request, kind: "admit" })).rejects.toThrow(
      "Foreground admission changed",
    );
    expect(
      await writeSessionForegroundRun({
        ...request,
        kind: "admit",
        admission: { ...admission, runId: "fresh-turn" },
      }),
    ).toBe(true);
    expect(await writeSessionForegroundRun({ ...request, kind: "stop" })).toBe(false);
    expect(loadSessionEntry(scope)).toMatchObject({
      status: "running",
      foregroundRun: { runId: "fresh-turn" },
    });
  });
});

it("rolls back the notice, terminal state and custody together when commit authority is lost", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await createSession();
    await writeSessionForegroundRun({
      kind: "admit",
      scope,
      admission,
      expectedWriterRunId: null,
      expectedRecovery,
      assertCurrent,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    ensureSessionPendingInputsSchema(database.db);
    const query = getSessionKysely(database.db);
    for (const [id, state, consumed] of [
      ["queued", "queued", null],
      ["interrupted", "interrupted", null],
      ["consumed", "queued", "saved-event"],
      ["cancelled", "cancelled", null],
    ] as const) {
      executeSqliteQuerySync(
        database.db,
        query.insertInto("session_pending_inputs").values({
          input_id: id,
          session_key: scope.sessionKey,
          session_id: admission.sessionId,
          idempotency_key: `${id}:user`,
          run_id: admission.runId,
          request_hash: id,
          message_json: JSON.stringify({ role: "user", content: id }),
          lifecycle_generation: admission.gatewayLifecycleGeneration,
          state,
          consumed_event_id: consumed,
          accepted_at: 1,
        }),
      );
    }
    let rejectCommit = true;
    const worker = bindSqliteWorkerBackend(undefined, {
      database: database.db,
      databasePath: database.path,
      admit(stage) {
        if (stage === "commit" && rejectCommit) {
          throw new Error("source revoked");
        }
      },
    });
    const command = {
      type: "stop" as const,
      input: {
        scope,
        admission,
        expectedWriterRunId: null,
        expectedRecovery,
        gatewayLifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
    };
    expect(() => worker.execute(command)).toThrow("source revoked");
    worker.assertSettled?.();
    expect(loadSessionEntry(scope)).toMatchObject({ status: "running" });
    expect(
      readForegroundStoppedReceiptInWorker({
        database: { agentId: scope.agentId, path: database.path },
        scope,
        expected,
      }),
    ).toEqual({ kind: "absent" });
    expect(
      executeSqliteQuerySync(
        database.db,
        query
          .selectFrom("session_pending_inputs")
          .select(["input_id", "state"])
          .where("input_id", "=", "queued"),
      ).rows,
    ).toEqual([{ input_id: "queued", state: "queued" }]);
    rejectCommit = false;
    const stopped = worker.execute(command);
    expect(stopped.changed).toBe(true);
    expect(stopped.notice?.message).toMatchObject({
      content: [
        {
          text: "The Gateway restarted. This turn was not resumed automatically for security reasons. Your conversation history is preserved. Send a new request to continue.",
        },
      ],
    });
    expect(
      executeSqliteQuerySync(
        database.db,
        query
          .selectFrom("session_pending_inputs")
          .select(["input_id", "state", "consumed_event_id"])
          .orderBy("input_id"),
      ).rows,
    ).toEqual([
      { input_id: "cancelled", state: "cancelled", consumed_event_id: null },
      { input_id: "consumed", state: "queued", consumed_event_id: "saved-event" },
      { input_id: "interrupted", state: "cancelled", consumed_event_id: null },
      { input_id: "queued", state: "cancelled", consumed_event_id: null },
    ]);
  });
});

it("preserves a current-generation foreground claim acquired before the stop transaction", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await createSession();
    const request = {
      scope,
      admission,
      expectedWriterRunId: null,
      expectedRecovery,
      assertCurrent,
    };
    expect(await writeSessionForegroundRun({ ...request, kind: "admit" })).toBe(true);
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const claim = await claimMainSessionRecoveryOwner({
      target: { ...scope, storePath: database.path },
      sessionId: admission.sessionId,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    expect(claim.kind).toBe("claimed");
    const claimed = loadSessionEntry(scope);
    expect(claimed?.mainRestartRecovery?.foregroundClaims?.tokens).toHaveLength(1);
    expect(await writeSessionForegroundRun({ ...request, kind: "stop" })).toBe(false);
    // Even a caller which observed that claim must not erase current custody.
    expect(
      await writeSessionForegroundRun({
        ...request,
        kind: "stop",
        expectedRecovery: captureForegroundRecoveryExpectation(claimed),
      }),
    ).toBe(false);
    expect(loadSessionEntry(scope)).toEqual(claimed);
    expect(
      readForegroundStoppedReceiptInWorker({
        database: { agentId: scope.agentId, path: database.path },
        scope,
        expected,
      }),
    ).toEqual({ kind: "absent" });
  });
});

it("uses neutral interruption wording within the same gateway generation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await createSession();
    const sameGeneration = {
      ...admission,
      gatewayLifecycleGeneration: getAgentEventLifecycleGeneration(),
    };
    await writeSessionForegroundRun({
      kind: "admit",
      scope,
      admission: sameGeneration,
      expectedWriterRunId: null,
      expectedRecovery,
      assertCurrent,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const worker = bindSqliteWorkerBackend(undefined, {
      database: database.db,
      databasePath: database.path,
      admit() {},
    });
    const result = worker.execute({
      type: "stop",
      input: {
        scope,
        admission: sameGeneration,
        expectedWriterRunId: null,
        expectedRecovery,
        gatewayLifecycleGeneration: sameGeneration.gatewayLifecycleGeneration,
      },
    });
    expect(result.changed).toBe(true);
    expect(result.notice?.message).toMatchObject({
      content: [{ text: expect.stringContaining("was interrupted") }],
    });
    expect(JSON.stringify(result.notice?.message)).not.toContain("gateway restarted");
  });
});
