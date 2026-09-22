import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
  updateSessionMentionProfileInvolvement,
  updateSessionProfileInvolvement,
} from "./session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
  readSessionSubmittedInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("pending input agent workers", () => {
  const fixture = useTempSessionsFixture("openclaw-input-worker-");
  const sessionId = "worker-session";
  const scope = () => ({
    agentId: "main",
    sessionKey: "agent:main:worker",
    sessionId,
    storePath: fixture.storePath(),
  });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const receipts: SessionPendingInputReceipt[] = [];
  const releases: Array<() => void> = [];
  const pendingOperations: Promise<unknown>[] = [];
  function own<T>(operation: Promise<T>): Promise<T> {
    pendingOperations.push(operation);
    void operation.catch(() => {});
    return operation;
  }
  const message = (runId: string) => ({
    role: "user" as const,
    content: "Worker input",
    timestamp: 100,
    idempotencyKey: runId + ":user",
  });
  const stage = async (
    runId: string,
    options: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
  ) => {
    const receipt = await stageSessionPendingInput(scope(), {
      runId,
      message: message(runId),
      assertCurrent: () => {},
      ...options,
    });
    if (!receipt) {
      throw new Error("Test input was not accepted");
    }
    receipts.push(receipt);
    return receipt;
  };
  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) {
      release();
    }
    await Promise.allSettled(pendingOperations.splice(0));
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
    }
  });
  it("publishes worker-backed mention involvement and preserves hidden replay state", async () => {
    const profileIds = ["synthetic-mention-profile"];
    const source = { generation: "mention-generation", sequence: 1, timestamp: 10 };
    const params = { expectedSessionId: sessionId, profileIds, source };
    const statements = trackSqliteStatementExecutions(database().db, ["writes"], (sql) =>
      /(?:UPDATE|INSERT INTO).*session_nodes/i.test(sql) ? "writes" : null,
    );
    try {
      expect(await updateSessionMentionProfileInvolvement(scope(), params)).toBe(true);
      expect(statements.counts.writes).toBe(0);
    } finally {
      statements.restore();
    }
    expect(loadSessionEntry(scope())?.profileInvolvement?.profiles[profileIds[0]!]).toMatchObject({
      hidden: false,
      lastMention: source,
    });
    updateSessionProfileInvolvement(scope(), {
      ...params,
      change: { kind: "visibility", hidden: true },
    });
    expect(await updateSessionMentionProfileInvolvement(scope(), params)).toBe(true);
    expect(loadSessionEntry(scope())?.profileInvolvement?.profiles[profileIds[0]!]?.hidden).toBe(
      true,
    );
    expect(
      await updateSessionMentionProfileInvolvement(scope(), {
        ...params,
        source: { ...source, sequence: 2 },
      }),
    ).toBe(true);
    expect(loadSessionEntry(scope())?.profileInvolvement?.profiles[profileIds[0]!]?.hidden).toBe(
      false,
    );
  });

  it("keeps staging FIFO while mention involvement commits during a custody wait", async () => {
    const prepared = createDeferred();
    const release = createDeferred();
    releases.push(() => release.resolve());
    const preparationOrder: string[] = [];
    const first = own(
      stage("custody-first", {
        prepareSourceCustody: async () => {
          preparationOrder.push("first");
          prepared.resolve();
          await release.promise;
        },
      }),
    );
    await Promise.race([prepared.promise, first]);
    const second = own(
      stage("custody-second", {
        prepareSourceCustody: () => {
          preparationOrder.push("second");
        },
      }),
    );
    const profileId = "custody-wait-profile";
    const source = { generation: "custody-wait-generation", sequence: 1, timestamp: 10 };
    expect(
      await own(
        updateSessionMentionProfileInvolvement(scope(), {
          expectedSessionId: sessionId,
          profileIds: [profileId],
          source,
        }),
      ),
    ).toBe(true);
    expect(loadSessionEntry(scope())?.profileInvolvement?.profiles[profileId]?.lastMention).toEqual(
      source,
    );
    expect(preparationOrder).toEqual(["first"]);
    expect(listSessionPendingInputs(scope()).items).toEqual([]);
    release.resolve();
    await Promise.all([first, second]);
    expect(preparationOrder).toEqual(["first", "second"]);
    expect(listSessionPendingInputs(scope()).items.map((input) => input.runId)).toEqual([
      "custody-first",
      "custody-second",
    ]);
  });

  it("awaits private source custody and rejects authority lost before acceptance", async () => {
    const prepared = createDeferred();
    const release = createDeferred();
    releases.push(() => release.resolve());
    let current = true;
    const pending = own(
      stage("await-custody", {
        prepareSourceCustody: async () => {
          prepared.resolve();
          await release.promise;
        },
        assertCurrent: () => {
          if (!current) {
            throw new Error("source revoked");
          }
        },
      }),
    );
    await Promise.race([prepared.promise, pending]);
    expect(listSessionPendingInputs(scope()).items).toEqual([]);
    current = false;
    release.resolve();
    await expect(pending).rejects.toThrow("source revoked");
    expect(listSessionPendingInputs(scope()).items).toEqual([]);
  });

  it("keeps pending source SQL on the agent workers", async () => {
    // Warm admission first; this assertion covers domain SQL, not startup schema admission.
    const first = await stage("worker-first");
    first.finish("interrupted");
    const statements = trackSqliteStatementExecutions(database().db, ["pending"], (sql) =>
      /session_pending_inputs|session_input_completions/.test(sql) ? "pending" : null,
    );
    try {
      await stage("worker-second");
      expect(await readSessionSubmittedInput(scope(), "worker-second:user")).toEqual(
        message("worker-second"),
      );
      expect(statements.counts.pending).toBe(0);
    } finally {
      statements.restore();
    }
  });
});
