import { AsyncLocalStorage } from "node:async_hooks";
import { serialize } from "node:v8";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  SQLITE_WORKER_MAX_REQUESTS,
  SQLITE_WORKER_MAX_QUEUED_BYTES,
} from "../infra/sqlite-worker-broker.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { AsyncWorkScope, runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type {
  MentionReadInput,
  MentionReadResult,
  MentionWorkerOperations,
} from "./mention-inbox-worker-contract.js";

/** The Inbox owns bounded FIFO work through commit publication and shutdown settlement. */
export function createMentionInboxPersistence(params: {
  revision: () => number;
  install: (result: Pick<MentionReadResult, "snapshot" | "audienceExpiryAt">) => void;
  assertActive: () => void;
}) {
  const { install, assertActive } = params;
  const queues = resolveGlobalSingleton(
    Symbol.for("openclaw.mentionInboxWriterQueues"),
    () => new Map<string, StoreWriterQueue>(),
  );
  const work = new AsyncWorkScope();
  const env = cloneEnvWithPlatformSemantics(process.env);
  const options = { env, path: resolveOpenClawStateSqlitePath(env) };
  const admissions = new AsyncLocalStorage<OpenClawStateWorkerContext>();
  const committedCompletion = new AsyncLocalStorage<{ active: boolean }>();
  const current = () => {
    const context = admissions.getStore();
    if (!context) {
      throw new Error("Mention storage requires its admitted operation");
    }
    return context;
  };
  let pendingCount = 0,
    pendingBytes = 0;
  let closing = false;
  async function enqueue<T>(input: unknown, operation: () => Promise<T>): Promise<T> {
    if (closing && !committedCompletion.getStore()?.active) {
      throw new Error("The mention Inbox is closing");
    }
    const context = captureOpenClawStateWorkerContext(options);
    const bytes = serialize(input).byteLength;
    if (
      pendingCount >= SQLITE_WORKER_MAX_REQUESTS ||
      pendingBytes + bytes > SQLITE_WORKER_MAX_QUEUED_BYTES
    ) {
      throw new Error("Mention Inbox admission capacity reached");
    }
    pendingCount++;
    pendingBytes += bytes;
    return await work
      .track(() =>
        runOutsideAsyncWorkScope(() =>
          runQueuedStoreWrite({
            queues,
            storePath: context.admission.identity.key,
            label: "mention Inbox",
            fn: () => admissions.run(context, operation),
          }),
        ),
      )
      .finally(() => {
        pendingCount--;
        pendingBytes -= bytes;
      });
  }
  async function readStore(input: Omit<MentionReadInput, "revision" | "now"> = {}) {
    const context = current();
    context.admission.assertCurrent();
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "mentions.read", input: { ...input, revision: params.revision(), now: Date.now() } },
    );
    context.admission.assertCurrent();
    assertActive();
    if (reply && (!reply.ok || reply.type !== "mentions.read")) {
      throw new Error("Mention storage read failed");
    }
    const result: MentionReadResult =
      reply?.ok && reply.type === "mentions.read"
        ? reply.result
        : {
            snapshot: { head: { revision: 0, nextSequence: 0 }, sources: [] },
            audienceExpiryAt: Infinity,
            cleanup: [],
          };
    install(result);
    return result;
  }
  async function mutate(
    operation: MentionWorkerOperations["mentions.mutate"]["input"]["operation"],
    assertCurrent = assertActive,
  ) {
    const context = current();
    const guard = () => {
      assertActive();
      assertCurrent();
    };
    const committed = await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const result = await scope.execute({
          type: "mentions.mutate",
          input: { revision: params.revision(), operation, now: Date.now() },
        });
        // Install only the durable worker outcome, within the retained publication scope.
        install(result);
        return result;
      },
      {
        assertCurrent: guard,
        createAdmission: createSqliteWorkerWriteAdmission(guard, [context.admission.databasePath]),
      },
    );
    return committed;
  }
  function reserveCommitted() {
    const context = captureOpenClawStateWorkerContext(options);
    const deferred = createDeferredCore<() => Promise<void>>();
    const pending = work.track(() =>
      runOutsideAsyncWorkScope(async () => {
        const complete = await deferred.promise;
        const owner = { active: true };
        try {
          await admissions.run(context, () => committedCompletion.run(owner, complete));
        } finally {
          owner.active = false;
        }
      }),
    );
    let started = false;
    return (complete: () => Promise<void>) => {
      if (!started) {
        started = true;
        deferred.resolve(complete);
      }
      return pending;
    };
  }
  return {
    enqueue,
    reserveCommitted,
    readStore,
    mutate,
    close() {
      closing = true;
      return work.drain();
    },
  };
}
