import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { settleSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import {
  dismissSubagentCompletionDelivery,
  retrySubagentCompletionDelivery,
} from "./subagent-completion-delivery.js";

const resumeSubagentRun = vi.hoisted(() => vi.fn());
vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("subagent completion recovery identity", () => {
  let database: OpenClawStateDatabase;

  beforeEach(() => {
    const tempDir = tempDirs.make(
      "openclaw-completion-recovery-",
      resolvePreferredOpenClawTmpDir(),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    database = openOpenClawStateDatabase();
    resumeSubagentRun.mockClear();
  });

  afterEach(() => {
    subagentRuns.clear();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function persistCompletion(
    name: "old" | "current",
    deliveryStatus: "suspended" | "delivered" = "suspended",
    remappedRun = false,
  ) {
    const now = Date.now();
    const subagent = createSubagentRunRecord({
      runId: remappedRun ? `completion-${name}` : `run-${name}`,
      taskRunId: remappedRun ? `run-${name}` : undefined,
      childSessionKey: "agent:main:subagent:shared",
      task: `finish ${name} work`,
      createdAt: now - (name === "old" ? 20_000 : 10_000),
      endedAt: now - 1_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      completion: { required: true, resultText: `${name} result`, capturedAt: now },
      delivery: {
        status: deliveryStatus,
        disposition: deliveryStatus === "suspended" ? "permanent_failure" : "delivered",
        generation: 1,
        ...(deliveryStatus === "suspended"
          ? { suspendedAt: now, suspendedReason: "expiry", lastError: "requester unavailable" }
          : { deliveredAt: now }),
      },
    });
    settleSubagentCompletionDelivery({ subagent, databaseOptions: { database } });
    subagentRuns.set(subagent.runId, subagent);
    return { subagent };
  }

  function storedPair(pair: ReturnType<typeof persistCompletion>) {
    const row = database.db
      .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get(pair.subagent.runId) as { payload_json: string } | undefined;
    return {
      subagent: row ? (JSON.parse(row.payload_json) as unknown) : undefined,
    };
  }

  function dismiss(taskId: string) {
    return dismissSubagentCompletionDelivery(taskId, {
      discardTerminalDelivery: SubagentLifecycleController.discardTerminalDelivery,
      databaseOptions: { database },
    });
  }

  it.each([false, true])(
    "dismisses only the selected result (remapped run: %s)",
    async (remapped) => {
      // Retained completions precede follow-up runs on the same reusable child session.
      const old = persistCompletion("old");
      const current = persistCompletion("current", "suspended", remapped);
      const oldRows = storedPair(old);
      const oldLive = structuredClone(old.subagent);

      await expect.soft(dismiss(current.subagent.runId)).resolves.toMatchObject({
        ok: true,
        run: { delivery: { status: "discarded" }, completion: { resultText: "current result" } },
      });
      expect.soft(storedPair(current).subagent).toMatchObject({
        delivery: {
          status: "discarded",
          disposition: "intentional_non_delivery",
        },
      });
      expect.soft(storedPair(old)).toEqual(oldRows);
      expect.soft(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
      expect(resumeSubagentRun).not.toHaveBeenCalled();
    },
  );

  it.each(["delivered", "suspended"] as const)(
    "retries the selected completion with an older %s run on its session",
    async (oldStatus) => {
      const old = persistCompletion("old", oldStatus);
      const current = persistCompletion("current", "suspended", true);
      const oldRows = storedPair(old);
      const oldLive = structuredClone(old.subagent);

      await expect
        .soft(retrySubagentCompletionDelivery(current.subagent.runId, { database }))
        .resolves.toMatchObject({
          ok: true,
          duplicateRisk: true,
          run: { delivery: { status: "pending" }, completion: { resultText: "current result" } },
        });
      expect.soft(resumeSubagentRun.mock.calls).toEqual([[current.subagent.runId]]);
      expect.soft(storedPair(current).subagent).toMatchObject({
        delivery: {
          status: "pending",
          generation: 2,
        },
      });
      expect.soft(storedPair(old)).toEqual(oldRows);
      expect.soft(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
    },
  );

  it.each(["dismiss", "retry"] as const)(
    "%s fails closed when only a sibling completion owner remains",
    async (action) => {
      const old = persistCompletion("old");
      const current = persistCompletion("current");
      subagentRuns.delete(current.subagent.runId);
      database.db.prepare("DELETE FROM subagent_runs WHERE run_id = ?").run(current.subagent.runId);
      const oldRows = storedPair(old);
      const currentRows = storedPair(current);
      const oldLive = structuredClone(old.subagent);

      const result = await (action === "dismiss"
        ? dismiss(current.subagent.runId)
        : retrySubagentCompletionDelivery(current.subagent.runId, { database }));

      expect(result).toEqual({
        ok: false,
        reason:
          action === "dismiss"
            ? "completion delivery is not blocked"
            : "task has no recoverable subagent completion",
      });
      expect(storedPair(old)).toEqual(oldRows);
      expect(storedPair(current)).toEqual(currentRows);
      expect(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
      expect(resumeSubagentRun).not.toHaveBeenCalled();
    },
  );
});
