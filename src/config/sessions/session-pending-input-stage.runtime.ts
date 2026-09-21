import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { openExistingOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import {
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import type {
  PendingInputStageInspection,
  PendingInputStageOperations,
  PendingInputStageRead,
  PendingInputStageWrite,
  SessionPendingInputAuthorityFacts,
  SessionPendingInputStageAuthority,
} from "./session-pending-input-stage.js";
import {
  inspectPendingInputStage,
  readPendingInputStageTranscript,
  commitPendingInputStage,
} from "./session-pending-input-stage.kernel.js";

export type PendingInputStageStorage = {
  assertCurrent(): void;
  inspect(input: PendingInputStageRead): Promise<PendingInputStageInspection>;
  transcript(input: PendingInputStageRead): Promise<PendingInputStageInspection["committed"]>;
  stage(input: PendingInputStageWrite): Promise<boolean>;
};

export async function withPendingInputStageStorage<T>(
  scope: ResolvedTranscriptScope & { path: string },
  options: { assertCurrent(): void; workerAuthority?: SessionPendingInputStageAuthority },
  run: (storage: PendingInputStageStorage) => Promise<T>,
): Promise<T | undefined> {
  const databaseOptions = toDatabaseOptions(scope);
  const authority = options.workerAuthority;
  // Opaque native callbacks and process-held incognito retain their existing owner.
  // An admitted worker error never selects this branch.
  if (!authority || isIncognitoOpenClawAgentSqlitePath(scope.path, databaseOptions)) {
    return runExclusiveSqliteSessionWrite(
      scope,
      async () => {
        options.assertCurrent();
        const database = openOpenClawAgentDatabase(databaseOptions);
        return run({
          assertCurrent: options.assertCurrent,
          inspect: async (input) => inspectPendingInputStage(database, input),
          transcript: async (input) => readPendingInputStageTranscript(database, input),
          stage: async (input) =>
            runOpenClawAgentWriteTransaction((current) => {
              options.assertCurrent();
              return commitPendingInputStage(current, input);
            }, databaseOptions),
        });
      },
      "session.pending-input.stage",
    );
  }
  authority.assertCurrent();
  const store = await openExistingOpenClawAgentSqliteWorkerStore<PendingInputStageOperations>(
    databaseOptions,
    {
      moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.pendingInputStage),
      input: { agentId: databaseOptions.agentId },
    },
  );
  if (!store) return undefined;
  try {
    authority.assertCurrent();
    return await store.run(
      async (worker) =>
        run({
          assertCurrent: authority.assertCurrent,
          inspect: (input) => worker.execute({ type: "pendingInput.inspect", input }),
          transcript: (input) => worker.execute({ type: "pendingInput.transcript", input }),
          stage: (input) => worker.execute({ type: "pendingInput.stage", input }),
        }),
      authority.assertCurrent,
      (_stage, facts) => {
        if (
          !isRecord(facts) ||
          facts.kind !== "session.pending-input" ||
          facts.agentId !== scope.agentId ||
          facts.storePath !== scope.path ||
          facts.sessionKey !== scope.sessionKey ||
          !Array.isArray(facts.members)
        ) {
          throw new Error("Pending input admission lost its exact session facts");
        }
        // SAFETY: Only this paired static domain builds facts after reading its admitted connection.
        authority.authorize(facts as SessionPendingInputAuthorityFacts);
      },
    );
  } finally {
    await store.close();
  }
}
