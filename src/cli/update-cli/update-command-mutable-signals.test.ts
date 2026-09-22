import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { resolveVitestNodeArgs } from "../../../scripts/lib/vitest-process-env.mts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { cronOwnerHardeningEntrypoints } from "../../cron/owner-hardening-runtime.test-support.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "../../infra/triage-runtime.test-support.js";
import { nativeFreeBsd, withFreeBsdFixture } from "../../infra/update-freebsd.test-support.js";
import { getUpdateRun, type createUpdateRun } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

const sourceImportArgs = resolveRuntimeWorkerUrl(
  updateExecutorNativeEntrypoints.executor,
).pathname.endsWith(".ts")
  ? ["--import", path.resolve("scripts/tsx.mjs")]
  : [];

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
it.skipIf(process.platform === "win32").each([
  { signal: "SIGINT", mode: "fresh" },
  { signal: "SIGTERM", mode: "fresh" },
  { signal: "SIGINT", mode: "inherited" },
  { signal: "SIGINT", mode: "handoff" },
  { signal: "SIGINT", mode: "pending" },
  { signal: "SIGINT", mode: "activating" },
  { signal: "SIGINT", mode: "migrated" },
  { signal: "SIGINT", mode: "lost" },
  { signal: "SIGINT", mode: "missing" },
  { signal: "SIGINT", mode: "completed" },
  { signal: "SIGINT", mode: "no-owner" },
  { signal: "SIGINT", mode: "state-refusal-drain" },
  { signal: "SIGINT", mode: "preview-refusal-drain" },
] as const)(
  "settles only the local pre-activation diagnostic under its real executor: $signal/$mode",
  ({ signal, mode }) =>
    nativeFreeBsd
      ? withFreeBsdFixture(({ home }) => assertOwnedSignal(home, signal, mode))
      : assertOwnedSignal(dirs.make("update-owned-signal-"), signal, mode),
  60000,
);

it.skipIf(!nativeFreeBsd).each([
  { signal: "SIGINT", mode: "root-pending" },
  { signal: "SIGTERM", mode: "root-pending" },
  { signal: "SIGINT", mode: "root-rejected" },
  { signal: "SIGTERM", mode: "root-rejected" },
] as const)(
  "preserves pending history after native ownership refusal: $signal/$mode",
  ({ signal, mode }) => withFreeBsdFixture(({ home }) => assertOwnedSignal(home, signal, mode)),
  60000,
);

async function assertOwnedSignal(
  root: string,
  signal: NodeJS.Signals,
  mode: string,
): Promise<void> {
  const script = path.join(root, "signal.mjs");
  fs.writeFileSync(
    script,
    `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { once } from 'node:events';
    import { createUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunPhase } from ${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.updateRunLedger).href)};
    import { createRetainedUpdateRecovery } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.retainedRecovery).href)};
    import { closeOpenClawStateDatabaseForTest } from ${JSON.stringify(resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.stateDatabase).href)};
    import { admitUpdateCommandRun, createUpdateRunProgress, completeUpdateCommandRun, withUpdatePreviewSignals } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.commandRun).href)};
    import { withUpdateCommandExecutor } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor).href)};
    import { registerSignalExitBarrier } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.signalExitBarrier).href)};
    import { createFreeBsdUpdateWriteAdmission } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.freebsdWriteAdmission).href)};
    import { writeControlPlaneUpdateRestartSentinelBestEffort } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.commandResult).href)};
    import { withUpdateCommandTerminalResult, deferUpdateCommandTerminalResult } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.commandTerminal).href)};
    const root = ${JSON.stringify(root)};
    const mode = ${JSON.stringify(mode)};
    const controlled = mode === 'state-refusal-drain' || mode === 'preview-refusal-drain';
    const opts = { restart: false, dryRun: mode === 'preview-refusal-drain' };
    if (mode === 'inherited') process.env.OPENCLAW_UPDATE_RUN_ID = createUpdateRun({trigger:'cli'}).runId;
    const run = await admitUpdateCommandRun({opts, root});
    if (controlled && !run.freebsdWriteAdmission) {
      // Exercise only the optional diagnostic latch on this host. Native lease
      // and filesystem owners keep their actual platform implementations.
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      try {
        Object.defineProperty(process, 'platform', {value:'freebsd'});
        run.freebsdWriteAdmission = createFreeBsdUpdateWriteAdmission();
      } finally { Object.defineProperty(process, 'platform', descriptor); }
      await run.freebsdWriteAdmission.revalidate(() => {});
    }

    await withUpdatePreviewSignals({...opts, run}, async () => {
      const sibling = createUpdateRun({trigger:'cli'});
      const hold = async () => {
        if (mode !== 'preview-refusal-drain') recordUpdateRunPhase(run.runId, 'validating');
        if (mode === 'handoff') process.env.OPENCLAW_UPDATE_RUN_HANDOFF = '1';
        if (mode === 'activating') recordUpdateRunPhase(run.runId, 'activating');
        if (mode === 'completed') finishUpdateRun(run.runId, {status:'skipped',reason:'already-current'});
        if (mode === 'pending' || mode === 'missing') {
          const from = {root,nodePath:process.execPath,version:'1.0.0',buildId:null};
          createRetainedUpdateRecovery({runId:run.runId,from,to:{...from,version:'2.0.0'}},{env:run.env});
        }
        const expected = getUpdateRun(run.runId);
        if (mode === 'migrated') {
          createUpdateRunProgress(run, {}).deferLedgerWrites();
          closeOpenClawStateDatabaseForTest();
          const { DatabaseSync } = await import('node:sqlite');
          const db = new DatabaseSync(root + '/state/openclaw.sqlite');
          db.exec('PRAGMA user_version = ' + (db.prepare('PRAGMA user_version').get().user_version + 1));
          db.close();
        }
        if (mode === 'missing') {
          closeOpenClawStateDatabaseForTest();
          fs.mkdirSync(root + '/state/.openclaw-restore-00000000-0000-4000-8000-000000000001-0');
          fs.renameSync(root + '/state/openclaw.sqlite',root + '/state/.openclaw-restore-00000000-0000-4000-8000-000000000001-0/displaced');
        }
        if (mode === 'root-pending') {
          if (!run.freebsdWriteAdmission) throw new Error('native admission missing');
          const entered = Promise.withResolvers();
          void run.freebsdWriteAdmission.revalidate(run.executorFence.assertCurrent, async () => {
            entered.resolve();
            await new Promise(() => {});
          }).catch(() => {});
          await entered.promise;
          if (run.freebsdWriteAdmission.canWrite) throw new Error('pending admission allowed writes');
        }
        if (mode === 'root-rejected') {
          if (!run.freebsdWriteAdmission) throw new Error('native admission missing');
          const failure = new Error('fixture authority refused');
          run.freebsdWriteAdmission.revoke(failure);
          if (run.freebsdWriteAdmission.canWrite) throw new Error('revoked admission allowed writes');
        }
        if (controlled) {
          const admission = run.freebsdWriteAdmission;
          const refused = Promise.withResolvers();
          const originalRevoke = admission.revoke;
          admission.revoke = (error) => {
            const first = originalRevoke(error);
            refused.resolve(first);
            return first;
          };
          const progress = createUpdateRunProgress(run, {});
          closeOpenClawStateDatabaseForTest();
          const pathname = root + '/state/openclaw.sqlite';
          const displaced = pathname + '.displaced';
          const replacement = pathname + '.replacement';
          fs.renameSync(pathname, displaced);
          fs.copyFileSync(displaced, pathname);
          const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
          const selectedBefore = hash(pathname);
          const originalBefore = hash(displaced);
          const marker = root + '/state/.openclaw-restore-signal-fixture';
          if (mode === 'preview-refusal-drain') fs.mkdirSync(marker);
          registerSignalExitBarrier(async () => {
            // Mutable signal entry follows its synchronous guard even when latching regresses.
            const first = mode === 'preview-refusal-drain' ? await refused.promise : admission.failure;
            const release = once(process,'message');
            process.send({kind:'barrier-entered',canWrite:admission.canWrite,refused:first instanceof Error});
            try {
            assert.equal(admission.canWrite, false);
            assert.equal(admission.failure, first);
            if (mode === 'preview-refusal-drain') fs.rmdirSync(marker);
            fs.renameSync(pathname, replacement);
            fs.renameSync(displaced, pathname);
            progress.onHeartbeat();
            progress.onRollbackOutcome({status:'failed',reason:'late callback'});
            progress.onStepStart({name:'late step',command:'fixture',index:0,total:1});
            progress.onStepComplete({name:'late step',command:'fixture',durationMs:1,exitCode:0,output:''});
            progress.flushLedgerWrites();
            assert.equal(completeUpdateCommandRun({status:'ok',mode:'npm',steps:[],durationMs:1},run).status,'error');
            await assert.rejects(writeControlPlaneUpdateRestartSentinelBestEffort({
              meta:{runId:run.runId,handoffId:'signal-fixture'},result:{status:'ok',mode:'npm',steps:[],durationMs:1},jsonMode:true,env:run.env,run,
            }), error => error === first);
            let published = false;
            await assert.rejects(withUpdateCommandTerminalResult(async (register) => {
              register(run);
              assert.equal(deferUpdateCommandTerminalResult(run, () => { published = true; }), true);
            }), {name:'UpdateCommandPendingRecoveryFailure'});
            assert.equal(published,false);
            assert.equal(admission.revoke(new Error('later refusal')), first);
            assert.equal(admission.canWrite,false);
            assert.equal(hash(pathname),originalBefore);
            assert.equal(hash(replacement),selectedBefore);
            process.send({kind:'refusal-drain',message:first.message,canWrite:admission.canWrite,firstStable:admission.failure===first,originalUnchanged:true,selectedUnchanged:true,published});
            } finally { await release; }
          });
        }
        process.send({runId:run.runId,expected,sibling});
        await new Promise(() => setInterval(() => {},1000));
      };
      if (mode === 'lost') {
        await withUpdateCommandExecutor(run.runId, async (executor) => {run.executorFence = await executor.enter(root);});
        await hold();
      } else if (mode === 'no-owner') {
        await hold();
      } else {
        await withUpdateCommandExecutor(run.runId, async (executor) => {run.executorFence = await executor.enter(root);await hold();});
      }
    });
  `,
  );
  const child = spawn(
    process.execPath,
    [...(process.versions.bun ? [] : resolveVitestNodeArgs()), ...sourceImportArgs, script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_SUPERVISOR_MODE: "external",
        OPENCLAW_UPDATE_RUN_ID: undefined,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_UPDATE_POST_CORE: undefined,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = once(child, "close");
  try {
    const message = await Promise.race([
      once(child, "message").then(
        ([payload]) =>
          payload as {
            runId: string;
            expected: ReturnType<typeof getUpdateRun>;
            sibling: ReturnType<typeof createUpdateRun>;
          },
      ),
      closed.then(() => {
        throw new Error(`Update process exited before ready: ${stderr}`);
      }),
    ]);
    const controlled = mode === "state-refusal-drain" || mode === "preview-refusal-drain";
    const proof = controlled
      ? Promise.race([
          new Promise<{ entry: unknown; receipt: Promise<unknown[]> }>((resolve) => {
            child.once("message", (entry) => {
              resolve({ entry, receipt: once(child, "message") });
            });
          }).then(async ({ entry, receipt }) => {
            expect(entry).toMatchObject({
              kind: "barrier-entered",
              canWrite: false,
              refused: true,
            });
            return (await receipt)[0];
          }),
          closed.then(() => {
            throw new Error(`Signal drain exited before proof: ${stderr}`);
          }),
        ])
      : undefined;
    expect(child.kill(signal)).toBe(true);
    if (proof) {
      const receipt = await proof;
      expect(receipt).toMatchObject({
        kind: "refusal-drain",
        canWrite: false,
        firstStable: true,
        originalUnchanged: true,
        selectedUnchanged: true,
        published: false,
      });
      expect(receipt.message).toContain(
        mode === "state-refusal-drain"
          ? "canonical state generation changed"
          : "Interrupted shared-database publication",
      );
      expect(child.exitCode).toBeNull();
      expect(child.connected).toBe(true);
      child.send("release drain");
    }
    const [code, exitSignal] = await closed;
    if (controlled || mode === "root-pending" || mode === "root-rejected" || code !== null) {
      expect(code).toBe(signal === "SIGINT" ? 130 : 143);
      expect(exitSignal).toBeNull();
    } else {
      expect(exitSignal).toBe(signal);
    }
    if (mode === "migrated") {
      expect(stderr).not.toContain("Update interruption could not be recorded");
      const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          db
            .prepare("SELECT status, phase, updated_at_ms FROM update_runs WHERE run_id = ?")
            .get(message.runId),
        ).toEqual({
          status: message.expected?.status,
          phase: message.expected?.phase,
          updated_at_ms: message.expected?.updatedAtMs,
        });
      } finally {
        db.close();
      }
      return;
    }
    const options =
      mode === "missing"
        ? {
            path: path.join(
              root,
              "state",
              ".openclaw-restore-00000000-0000-4000-8000-000000000001-0",
              "displaced",
            ),
          }
        : { env: { OPENCLAW_STATE_DIR: root } };
    const actual = getUpdateRun(message.runId, options);
    if (mode === "fresh") {
      expect(actual).toMatchObject({
        status: "failed",
        phase: "finished",
        reason: "interrupted",
      });
      expect(actual?.steps.some((step) => step.status === "in_progress")).toBe(false);
    } else {
      expect(actual).toEqual(message.expected);
    }
    expect(getUpdateRun(message.sibling.runId, options)).toEqual(message.sibling);
    if (mode === "root-pending" || mode === "root-rejected") {
      expect(stderr).toContain(
        "Update interruption could not be recorded; history remains pending.",
      );
    }
    if (mode === "missing") {
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(fs.existsSync(path.join(root, "state", `openclaw.sqlite${suffix}`))).toBe(false);
      }
    }
  } finally {
    if (child.connected) {
      child.send("release drain", () => {});
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  }
}
