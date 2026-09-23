import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readOpenClawAgentDatabaseRegistryToken } from "./openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAdmission,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { runOpenClawAgentWriteAdmission } from "./openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function fixture() {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-create-owner-")) };
  const options = { agentId: "main", env };
  return { ...options, path: resolveOpenClawAgentSqlitePath(options) };
}

function source(
  beforeGrant: (request: SqliteWorkerAdmissionRequest) => void = () => {},
  assertCurrent: () => void = () => {},
): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent,
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          beforeGrant(request);
          binding.authorize(request);
          assertCurrent();
          if (!grant()) {
            throw new Error("Creating-open fixture lost its admission");
          }
        }),
      });
    },
  };
}

describe("canonical agent creating admission", () => {
  it("opens a missing store only through creating admission", async () => {
    const options = fixture();
    const execution = captureOpenClawAgentDatabaseExecution(options);
    const existingOperation = vi.fn(async () => "existing");
    const creatingOperation = vi.fn(async () => "created");
    try {
      await expect(execution.runExisting(source(), existingOperation)).resolves.toBeUndefined();
      expect(existingOperation).not.toHaveBeenCalled();
      expect(fs.existsSync(options.path)).toBe(false);

      await expect(execution.runCreate(source(), creatingOperation)).resolves.toBe("created");
      expect(creatingOperation).toHaveBeenCalledOnce();
      expect(fs.existsSync(options.path)).toBe(true);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(listOpenClawRegisteredAgentDatabases({ env: options.env })).toEqual([
        expect.objectContaining({ agentId: "main", path: options.path }),
      ]);
      await expect(execution.runExisting(source(), existingOperation)).resolves.toBe("existing");
      expect(existingOperation).toHaveBeenCalledOnce();
    } finally {
      await execution.release();
    }
  });

  it.each(["missing", "replacement"] as const)(
    "does not create over a captured existing owner that becomes %s before open",
    async (change) => {
      const options = fixture();
      openOpenClawAgentDatabase(options);
      await closeOpenClawAgentDatabaseByPathAsync(options.path);
      const replacementPath = path.join(path.dirname(options.path), "replacement.sqlite");
      if (change === "replacement") {
        openOpenClawAgentDatabase({ ...options, path: replacementPath });
        await closeOpenClawAgentDatabaseByPathAsync(replacementPath);
      }
      const execution = captureOpenClawAgentDatabaseExecution(options);
      let changed = false;
      const operation = vi.fn(async () => "must not enter");
      const owner = source((request) => {
        if (!changed && request.stage === "open") {
          changed = true;
          fs.renameSync(options.path, `${options.path}.captured`);
          if (change === "replacement") {
            fs.renameSync(replacementPath, options.path);
          }
        }
      });
      try {
        await expect(execution.runCreate(owner, operation)).rejects.toThrow(
          change === "missing" ? /ENOENT/ : /identity|physical|changed|replaced/i,
        );
        expect(changed).toBe(true);
        expect(operation).not.toHaveBeenCalled();
        expect(fs.existsSync(options.path)).toBe(change === "replacement");
        expect(fs.existsSync(`${options.path}.captured`)).toBe(true);
      } finally {
        await execution.release();
      }
    },
  );

  it("joins the same canonical pending creator instead of rejecting its new file", async () => {
    const options = fixture();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const opening = withOpenClawAgentDatabaseAdmission(
      options,
      (run) =>
        runOpenClawAgentWriteAdmission(options, async () => {
          entered.resolve();
          await release.promise;
          return run(() => {});
        }),
      (database) => database,
    );
    await entered.promise;
    expect(fs.existsSync(options.path)).toBe(false);
    const execution = captureOpenClawAgentDatabaseExecution(options);
    const operation = vi.fn(async () => "joined canonical creator");
    const creating = execution.runCreate(source(), operation).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      release.resolve();
      const database = await opening;
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBe(database);
      await expect(creating).resolves.toEqual({ value: "joined canonical creator" });
      expect(operation).toHaveBeenCalledOnce();
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBe(database);
    } finally {
      release.resolve();
      await Promise.allSettled([opening, creating]);
      await execution.release();
    }
  });

  it("publishes witnessed registration after caller revocation without replaying its operation", async () => {
    const options = fixture();
    const execution = captureOpenClawAgentDatabaseExecution(options);
    const refused = new Error("Synthetic creating caller revoked after registration COMMIT");
    let revoked = false;
    let witnessed = 0;
    let publications = 0;
    const stop = sessionChanges.subscribe((change) => {
      if ("all" in change && change.all && change.scope === "stores") {
        publications += 1;
      }
    });
    const owner = source(
      (request) => {
        if (
          request.stage === "prepare" &&
          isRecord(request.facts) &&
          request.facts.kind === "agent-registration-committed"
        ) {
          witnessed += 1;
          revoked = true;
        }
      },
      () => {
        if (revoked) {
          throw refused;
        }
      },
    );
    const operation = vi.fn(async () => "must not replay");
    try {
      const result = await execution
        .runCreate(owner, operation, { retireNativeOnFailure: true })
        .then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
      // Registration committed, but the creating factory did not obtain its remaining grant.
      expect(result.error).toBe(refused);
      expect(witnessed).toBe(1);
      expect(publications).toBe(1);
      expect(operation).not.toHaveBeenCalled();
      expect(listOpenClawRegisteredAgentDatabases({ env: options.env })).toEqual([
        expect.objectContaining({ agentId: "main", path: options.path }),
      ]);
      await closeOpenClawAgentDatabaseByPathAsync(options.path);
    } finally {
      stop();
      await execution.release();
    }
  });

  it("publishes committed registration even when its registry follower rejects completion", async () => {
    const options = fixture();
    readOpenClawAgentDatabaseRegistryToken({ env: options.env });
    const execution = captureOpenClawAgentDatabaseExecution(options);
    const failure = new Error("Synthetic registry follower rejected completion");
    let committed = false;
    let publications = 0;
    const stop = sessionChanges.subscribe((change) => {
      if ("all" in change && change.all && change.scope === "stores") {
        publications += 1;
      }
    });
    const owner = source((request) => {
      if (
        request.stage === "prepare" &&
        isRecord(request.facts) &&
        request.facts.kind === "agent-registration-committed"
      ) {
        committed = true;
      }
    });
    owner.onRegistryChange = () => {
      if (committed) {
        throw failure;
      }
    };
    const operation = vi.fn(async () => "must not replay");
    try {
      await expect(execution.runCreate(owner, operation)).rejects.toBe(failure);
      expect(committed).toBe(true);
      expect(publications).toBe(1);
      expect(operation).not.toHaveBeenCalled();
      expect(listOpenClawRegisteredAgentDatabases({ env: options.env })).toEqual([
        expect.objectContaining({ agentId: "main", path: options.path }),
      ]);
    } finally {
      stop();
      await execution.release();
    }
  });

  it("joins an admitted creating scope before completing explicit close", async () => {
    const options = fixture();
    const execution = captureOpenClawAgentDatabaseExecution(options);
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    let finishedClose = false;
    const operation = execution.runCreate(source(), async () => {
      entered.resolve();
      await finish.promise;
      return "settled";
    });
    const outcome = operation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let closing: Promise<boolean> | undefined;
    try {
      await entered.promise;
      closing = closeOpenClawAgentDatabaseByPathAsync(options.path).then((result) => {
        finishedClose = true;
        return result;
      });
      expect(() => execution.assertCurrent()).toThrow(/closed/);
      expect(finishedClose).toBe(false);
      finish.resolve();
      await outcome;
      await closing;
      expect(finishedClose).toBe(true);
      expect(fs.existsSync(options.path)).toBe(true);
    } finally {
      finish.resolve();
      await outcome;
      await closing;
      await execution.release();
    }
  });
});
