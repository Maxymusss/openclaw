import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { prepareClaimedSessionDelivery } from "../../../infra/session-delivery-queue.records.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { readSubagentRun } from "../registry/subagent-registry.store.sqlite.js";
import {
  admitSubagentCompletionDelivery,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
function records() {
  const subagent = createSubagentRunRecord({
    runId: "completion-run",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    expectsCompletionMessage: true,
    endedAt: 100,
    outcome: { status: "ok" },
    completion: { required: true, resultText: "canonical result", capturedAt: 100 },
    delivery: {
      status: "in_progress",
      disposition: "session_queued",
      generation: 1,
      queueId: "pending",
      deadlineAt: 2000,
    },
  });
  const queueEntry = prepareClaimedSessionDelivery(
    {
      kind: "agentTurn",
      sessionKey: subagent.requesterSessionKey,
      message: "load native result at delivery time",
      messageId: "completion:1",
      idempotencyKey: "completion:1",
      owner: {
        kind: "subagent_completion",
        runId: subagent.runId,
        taskId: subagent.runId,
        generation: 1,
        deadlineAt: 2000,
      },
    },
    125000,
    100,
  );
  subagent.delivery!.queueId = queueEntry.id;
  return { subagent, queueEntry };
}

describe("native subagent completion admission", () => {
  let database: OpenClawStateDatabase;
  beforeEach(() => {
    database = openOpenClawStateDatabase({
      path: path.join(directories.make("subagent-native-admission-"), "state.sqlite"),
    });
    // Fresh schema admission must not recreate the retired generic Task ledger.
    expect(
      database.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('task_runs', 'task_delivery_state', 'flow_runs')",
        )
        .all(),
    ).toEqual([]);
  });
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });
  function count(table: "delivery_queue_entries" | "subagent_runs") {
    return database.db.prepare("SELECT COUNT(*) AS count FROM " + table).get()?.count;
  }
  it("commits one queue generation and native result atomically, then deduplicates its replay", () => {
    const input = records();
    const phases: string[] = [];
    const result = admitSubagentCompletionDelivery({
      ...input,
      databaseOptions: { database },
      testHooks: {
        afterMutation(phase, exact) {
          expect(exact).toBe(database);
          expect(exact.db.isTransaction).toBe(true);
          phases.push(phase);
        },
      },
    });
    expect(result).toEqual({ claimed: true, status: "pending" });
    expect(phases).toEqual(["queue", "subagent"]);
    expect(count("delivery_queue_entries")).toBe(1);
    expect(count("subagent_runs")).toBe(1);
    expect(
      admitSubagentCompletionDelivery({ ...input, databaseOptions: { database } }).claimed,
    ).toBe(false);
    input.subagent.delivery!.status = "delivered";
    settleSubagentCompletionDelivery({ subagent: input.subagent, databaseOptions: { database } });
    expect(readSubagentRun(database, input.subagent.runId)?.delivery?.status).toBe("delivered");
  });
  it.each(["queue", "subagent"] as const)(
    "rolls back both native owners after a crash at %s",
    (phase) => {
      expect(() =>
        admitSubagentCompletionDelivery({
          ...records(),
          databaseOptions: { database },
          testHooks: {
            afterMutation(actual) {
              if (actual === phase) {
                throw new Error("crash cut point");
              }
            },
          },
        }),
      ).toThrow("crash cut point");
      expect(count("delivery_queue_entries")).toBe(0);
      expect(count("subagent_runs")).toBe(0);
    },
  );
  it("refuses a mismatched delivery generation before writes", () => {
    const input = records();
    input.subagent.delivery!.generation = 2;
    expect(() =>
      admitSubagentCompletionDelivery({ ...input, databaseOptions: { database } }),
    ).toThrow("one owner generation");
    expect(count("delivery_queue_entries")).toBe(0);
    expect(count("subagent_runs")).toBe(0);
  });
});
