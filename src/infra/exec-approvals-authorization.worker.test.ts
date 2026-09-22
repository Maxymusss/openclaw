import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import { commitExecAuthorizationsInWorker } from "./exec-approvals-authorization.worker.js";
import type { ExecAuthorizationCommitInput } from "./exec-approvals-contracts.js";
import { writeExecApprovalsConfigRow } from "./exec-approvals-sqlite.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    stateDatabase.closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const entry = { id: "echo", pattern: "/usr/bin/echo" };
const input: ExecAuthorizationCommitInput = {
  agentId: "main",
  matches: [],
  command: "echo first",
  authorization: {
    source: "current-policy",
    security: "allowlist",
    ask: "on-miss",
    allowlistSatisfied: true,
  },
};
function fixture() {
  const root = tempDirs.make("openclaw-exec-authorization-batch-");
  const options = {
    path: path.join(root, "state", "openclaw.sqlite"),
    env: { OPENCLAW_STATE_DIR: root },
  };
  const database = stateDatabase.openOpenClawStateDatabase(options);
  writeExecApprovalsConfigRow({
    db: database.db,
    file: { version: 1, agents: { main: { allowlist: [entry] } } },
  });
  // These direct kernel tests stand in for the mandatory host port. Real
  // transaction/commit revocation is exercised by the read-worker suite.
  const admissions = vi
    .spyOn(workerAdmission, "requestSqliteWorkerOperationAdmission")
    .mockImplementation(() => {
      expect(database.db.isTransaction).toBe(true);
    });
  return { options, database, admissions };
}

it("does not acquire writer admission for an unchanged authorization batch", () => {
  const { options, admissions } = fixture();
  const writes = vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction");
  const outcomes = commitExecAuthorizationsInWorker({ items: [input, input] }, options);
  expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
  expect(writes).not.toHaveBeenCalled();
  expect(admissions).not.toHaveBeenCalled();
});

it("coalesces usage writes and rereads policy after writer admission", () => {
  const { options, database, admissions } = fixture();
  const write = stateDatabase.runOpenClawStateWriteTransaction;
  const writes = vi
    .spyOn(stateDatabase, "runOpenClawStateWriteTransaction")
    .mockImplementationOnce((operation, owner, transactionOptions) => {
      writeExecApprovalsConfigRow({
        db: database.db,
        file: { version: 1, defaults: { security: "deny" } },
      });
      return write(operation, owner, transactionOptions);
    });
  const outcomes = commitExecAuthorizationsInWorker(
    {
      items: [
        { ...input, matches: [entry] },
        { ...input, matches: [entry], command: "echo last" },
      ],
    },
    options,
  );
  expect(writes).toHaveBeenCalledTimes(1);
  expect(admissions.mock.calls.map(([request]) => request.stage)).toEqual([
    "transaction",
    "commit",
  ]);
  expect(outcomes).toEqual([
    { ok: false, message: "Exec approval changed before execution" },
    { ok: false, message: "Exec approval changed before execution" },
  ]);
});

it("commits accepted usage once and preserves the agent deletion fence", () => {
  const { options, database, admissions } = fixture();
  writeExecApprovalsConfigRow({
    db: database.db,
    file: { version: 1, agents: { main: { allowlist: [entry] }, deleted: { allowlist: [entry] } } },
  });
  database.db
    .prepare(
      "INSERT INTO agent_deletion_journal(agent_id,operation_id,agent_dir,workspace_dir,sessions_dir,created_at) VALUES('deleted','deletion','/agent','/workspace','/sessions',1)",
    )
    .run();
  const writes = vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction");
  const outcomes = commitExecAuthorizationsInWorker(
    {
      items: [
        { ...input, matches: [entry] },
        { ...input, agentId: "deleted", matches: [entry] },
        { ...input, matches: [entry], command: "echo last" },
      ],
    },
    options,
  );
  expect(writes).toHaveBeenCalledTimes(1);
  expect(admissions.mock.calls.map(([request]) => request.stage)).toEqual([
    "transaction",
    "commit",
  ]);
  expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false, true]);
  expect(outcomes[2]).toMatchObject({
    ok: true,
    snapshot: {
      file: {
        agents: {
          main: { allowlist: [{ lastUsedCommand: "echo last" }] },
          deleted: { allowlist: [entry] },
        },
      },
    },
  });
});
