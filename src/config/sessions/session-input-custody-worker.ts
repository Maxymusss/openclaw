import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { updateSessionProfileInvolvementInDatabase } from "./session-accessor.involvement-kernel.js";
import {
  readPendingInputAdmission,
  insertPendingInputAdmission,
} from "./session-accessor.pending-input-admission.js";
import type { SessionInputCustodyOperations } from "./session-input-custody.worker.js";

/** One captured agent owner; ordinary SQL executes only on its broker worker. */
export function captureSessionInputCustodyWorker(inputOptions: OpenClawAgentDatabaseOptions) {
  const env = cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = {
    ...inputOptions,
    env,
    path: resolveOpenClawAgentSqlitePath({ ...inputOptions, env }),
  };
  const path = options.path;
  const incognito = isIncognitoOpenClawAgentSqlitePath(path, options);
  const execution = incognito ? undefined : captureOpenClawAgentDatabaseExecution(options);
  async function run(
    command: { type: "inspect"; input: SessionInputCustodyOperations["inspect"]["input"] },
    assertCurrent: () => void,
  ): Promise<SessionInputCustodyOperations["inspect"]["output"]>;
  async function run(
    command: { type: "accept"; input: SessionInputCustodyOperations["accept"]["input"] },
    assertCurrent: () => void,
  ): Promise<boolean>;
  async function run(
    command: { type: "mention"; input: SessionInputCustodyOperations["mention"]["input"] },
    assertCurrent: () => void,
  ): Promise<SessionInputCustodyOperations["mention"]["output"]>;
  async function run(
    command: SqliteWorkerCommand<SessionInputCustodyOperations>,
    assertCurrent: () => void,
  ): Promise<SessionInputCustodyOperations[keyof SessionInputCustodyOperations]["output"]> {
    const assert = () => {
      execution?.assertCurrent();
      assertCurrent();
    };
    assert();
    if (incognito) {
      const value = runOpenClawAgentWriteTransaction((database) => {
        assert();
        if (command.type === "inspect") {
          return readPendingInputAdmission(database, command.input);
        }
        if (command.type === "accept") {
          return insertPendingInputAdmission(database, command.input);
        }
        return updateSessionProfileInvolvementInDatabase(
          database,
          command.input,
          command.input.params,
        );
      }, options);
      return value;
    }
    return runOpenClawAgentWriteAdmission(
      options,
      () =>
        withOpenClawAgentDatabaseAsync(
          options,
          async (database) => {
            assert();
            const worker = await openOpenClawAgentSqliteWorkerStore<SessionInputCustodyOperations>(
              options,
              database.db,
              {
                moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionInputCustody),
                input: { agentId: options.agentId },
              },
            );
            try {
              return await worker.run((scope) => scope.execute(command), assert);
            } finally {
              await worker.close();
            }
          },
          assert,
        ),
      true,
    );
  }
  return { run, release: () => execution?.release() ?? Promise.resolve() };
}
