import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { CronRunHistoryWrite } from "./run-history.types.js";

export async function recordCronRun(input: CronRunHistoryWrite): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  const captured = structuredClone(input);
  const assertCurrent = () => context.admission.assertCurrent();
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "cron.recordRun", input: captured }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}

export async function pruneCronRunHistory(now: number): Promise<number> {
  const context = captureOpenClawStateWorkerContext();
  const assertCurrent = () => context.admission.assertCurrent();
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "cron.pruneHistory", input: { now } }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}
