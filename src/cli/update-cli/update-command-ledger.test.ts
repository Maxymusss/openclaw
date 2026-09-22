import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { createFreeBsdUpdateWriteAdmission } from "../../infra/update-freebsd-write-admission.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  getUpdateRun,
  heartbeatUpdateRun,
} from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { admitUpdateCommandLedger, updateCommandLedgerOptions } from "./update-command-ledger.js";
import { completeUpdateCommandRun, createUpdateRunProgress } from "./update-command-run.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

async function admittedRun(env: NodeJS.ProcessEnv) {
  const admission = withMockedPlatform("freebsd", () => createFreeBsdUpdateWriteAdmission()!);
  await admission.revalidate(() => {});
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } }, { env })
      .runId,
    env,
    freebsdWriteAdmission: admission,
  };
  admitUpdateCommandLedger(run);
  return { run, admission };
}

it.each(["cloned environment", "state selector", "config selector", "run id", "missing admission"])(
  "refuses the first callback after changing its %s without an execution guard",
  async (change) => {
    await withTestDir({ prefix: "update-ledger-binding-" }, async (root) => {
      const env = {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      };
      const { run, admission } = await admittedRun(env);
      const originalId = run.runId;
      const before = getUpdateRun(originalId, { env });
      const progress = createUpdateRunProgress(run, {});
      if (change === "cloned environment") {
        run.env = { ...env };
      }
      if (change === "state selector") {
        env.OPENCLAW_STATE_DIR = path.join(root, "other");
      }
      if (change === "config selector") {
        env.OPENCLAW_CONFIG_PATH = path.join(root, "other.json");
      }
      if (change === "run id") {
        run.runId = "different-run";
      }
      if (change === "missing admission") {
        run.ledgerAdmission = undefined;
      }
      expect(() => progress.onHeartbeat?.()).toThrow();
      const first = admission.failure;
      expect(first).toBeInstanceOf(Error);
      expect(admission.canWrite).toBe(false);
      env.OPENCLAW_STATE_DIR = root;
      env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
      run.env = env;
      run.runId = originalId;
      progress.onHeartbeat?.();
      progress.flushLedgerWrites();
      expect(admission.revoke(new Error("later refusal"))).toBe(first);
      expect(getUpdateRun(originalId, { env })).toEqual(before);
      expect(fs.existsSync(path.join(root, "other"))).toBe(false);
    });
  },
);

it("rechecks prepared options at the writer and keeps two runs sharing an environment independent", async () => {
  await withTestDir({ prefix: "update-ledger-two-runs-" }, async (root) => {
    const env = { OPENCLAW_STATE_DIR: root };
    const first = await admittedRun(env);
    const second = await admittedRun(env);
    const firstOptions = updateCommandLedgerOptions(first.run);
    const before = getUpdateRun(first.run.runId, { env });
    first.run.env = { ...env };
    expect(() =>
      heartbeatUpdateRun(first.run.runId, readUpdateRunDriver(), firstOptions),
    ).toThrow();
    expect(first.admission.canWrite).toBe(false);
    const secondBefore = getUpdateRun(second.run.runId, { env });
    createUpdateRunProgress(second.run, {}).onHeartbeat?.();
    expect(second.admission.canWrite).toBe(true);
    expect(getUpdateRun(second.run.runId, { env })?.updatedAtMs).toBeGreaterThan(
      secondBefore!.updatedAtMs,
    );
    expect(getUpdateRun(first.run.runId, { env })).toEqual(before);
    expect(() => heartbeatUpdateRun(second.run.runId, readUpdateRunDriver(), firstOptions)).toThrow(
      first.admission.failure,
    );
  });
});

it("requires a receiver's own binding and retains ordinary diagnostics after executor release", async () => {
  await withTestDir({ prefix: "update-ledger-receiver-" }, async (root) => {
    const { run, admission } = await admittedRun({ OPENCLAW_STATE_DIR: root });
    const receiver = { ...run };
    expect(() => updateCommandLedgerOptions(receiver)).toThrow("another run");
    expect(admission.canWrite).toBe(false);
    const local = await admittedRun(run.env);
    const privateRoot = path.join(root, "private");
    fs.mkdirSync(privateRoot, { mode: 0o700 });
    vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(privateRoot);
    await withUpdateCommandExecutor(local.run.runId, async (executor) => {
      local.run.executorFence = await executor.enter(root);
    });
    expect(() => local.run.executorFence?.assertCurrent()).toThrow();
    expect(
      completeUpdateCommandRun(
        { status: "error", mode: "npm", reason: "ordinary failure", steps: [], durationMs: 1 },
        local.run,
      ).status,
    ).toBe("error");
    expect(getUpdateRun(local.run.runId, { env: run.env })).toMatchObject({
      status: "failed",
      reason: "ordinary failure",
    });
    expect(local.admission.canWrite).toBe(true);
  });
});

it("leaves ordinary Linux writers unbound after a generation change", async () => {
  await withTestDir({ prefix: "update-ledger-linux-" }, async (root) => {
    const env = { OPENCLAW_STATE_DIR: root };
    const run = {
      runId: createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } }, { env })
        .runId,
      env,
    };
    admitUpdateCommandLedger(run);
    expect(updateCommandLedgerOptions(run)).toEqual({ env });
    closeOpenClawStateDatabaseForTest();
    const pathname = resolveOpenClawStateSqlitePath(env);
    fs.renameSync(pathname, pathname + ".prior");
    fs.copyFileSync(pathname + ".prior", pathname);
    const before = getUpdateRun(run.runId, { env });
    createUpdateRunProgress(run, {}).onHeartbeat?.();
    expect(getUpdateRun(run.runId, { env })?.updatedAtMs).toBeGreaterThan(before!.updatedAtMs);
  });
});

it("does not recapture a deferred parent's generation when flushing; a receiver admits its own", async () => {
  await withTestDir({ prefix: "update-ledger-deferred-" }, async (root) => {
    const env = { OPENCLAW_STATE_DIR: root };
    const { run, admission } = await admittedRun(env);
    const progress = createUpdateRunProgress(run, {});
    progress.deferLedgerWrites();
    progress.onStepStart?.({ name: "buffered step", command: "fixture", index: 0, total: 1 });
    const before = getUpdateRun(run.runId, { env });
    closeOpenClawStateDatabaseForTest();
    const pathname = resolveOpenClawStateSqlitePath(env);
    const displaced = pathname + ".prior";
    fs.renameSync(pathname, displaced);
    fs.copyFileSync(displaced, pathname);
    expect(() => progress.flushLedgerWrites()).toThrow();
    expect(admission.canWrite).toBe(false);
    expect(getUpdateRun(run.runId, { env })).toEqual(before);
    expect(getUpdateRun(run.runId, { env, path: displaced })).toEqual(before);

    const receiverAdmission = withMockedPlatform("freebsd", () =>
      createFreeBsdUpdateWriteAdmission()!,
    );
    await receiverAdmission.revalidate(() => {});
    // The authenticated finalizer performs this local adoption before minting its binding.
    adoptUpdateRun(run.runId, { env });
    const receiver = { runId: run.runId, env, freebsdWriteAdmission: receiverAdmission };
    admitUpdateCommandLedger(receiver);
    createUpdateRunProgress(receiver, {}).onStepStart?.({
      name: "buffered step",
      command: "fixture",
      index: 0,
      total: 1,
    });
    expect(getUpdateRun(run.runId, { env })?.steps).toContainEqual(
      expect.objectContaining({ step: "buffered step", status: "in_progress" }),
    );
    expect(getUpdateRun(run.runId, { env, path: displaced })).toEqual(before);
    expect(admission.canWrite).toBe(false);
    expect(receiverAdmission.canWrite).toBe(true);
  });
});
