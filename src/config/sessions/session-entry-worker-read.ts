import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmissions } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "./session-transcript-worker-runtime.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import type { InternalSessionEntry } from "./types.js";

type CapturedRead = {
  scope: SessionAccessScope;
  candidates: readonly SessionStoreReadCandidate[];
  resolved?: ResolvedSqliteScope;
  inventory?: ReturnType<typeof prepareSessionStoreTargetInventory>;
  registry?: ReturnType<typeof prepareOpenClawAgentDatabaseRegistrySnapshotRead>;
};

function captureRead(input: SessionAccessScope): CapturedRead {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const scope = {
    ...input,
    ...(input.storePath !== undefined ? { storePath: path.resolve(input.storePath) } : {}),
    env,
  };
  if (
    isIncognitoSessionKey(scope.sessionKey) ||
    !scope.storePath ||
    resolveUnsuffixedSqliteTargetFromSessionStorePath(scope.storePath).agentId
  ) {
    const resolved = captureLifecycleDatabaseScope(resolveSqliteScope(scope));
    return { scope, resolved, candidates: [captureSessionStoreReadCandidate(resolved.path!)] };
  }
  const agentId = scope.agentId ?? parseAgentSessionKey(scope.sessionKey)?.agentId ?? "main";
  const inventory = prepareSessionStoreTargetInventory(
    { session: { store: scope.storePath } },
    [agentId],
    env,
  );
  return {
    scope,
    inventory,
    candidates: inventory.candidates,
    registry: prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env }),
  };
}

type SelectedRead = {
  captured: CapturedRead;
  resolved: ResolvedSqliteScope;
  physicalPath: string;
  assertCurrent: () => void;
};

/** Fresh logical rows consumed together while every selected reader and writer order is retained. */
export async function withSessionEntriesWorkerRead<T>(
  inputs: readonly SessionAccessScope[],
  consume: (entries: readonly (InternalSessionEntry | undefined)[]) => T,
): Promise<T> {
  // Capture every locator before discovery of the first source can yield.
  const captured = inputs.map(captureRead);
  const selected: SelectedRead[] = [];
  const consumeSync = (entries: readonly (InternalSessionEntry | undefined)[]): T => {
    const result = consume(entries);
    if (isPromiseLike(result)) throw new Error("Session entry consumers must remain synchronous");
    return result;
  };
  const readAll = async (): Promise<T> => {
    const durable = selected.filter(
      (item) =>
        !isIncognitoOpenClawAgentSqlitePath(item.resolved.path!, toDatabaseOptions(item.resolved)),
    );
    return await withSessionHistoryWorkerDatabases(
      durable.map((item) => ({ ...toDatabaseOptions(item.resolved), path: item.physicalPath })),
      (owners) =>
        runOpenClawAgentWriteAdmissions(
          selected.map((item) => toDatabaseOptions(item.resolved)),
          async () => {
            const assertCurrent = () => {
              for (const item of selected) item.assertCurrent();
              for (const owner of owners) owner.assertCurrent();
            };
            assertCurrent();
            const lookupKeys = selected.map(
              (item) => new Set(collectSessionEntryLookupKeys(undefined, item.resolved.sessionKey)),
            );
            let changed = false;
            const unsubscribe = sessionChanges.subscribe((change) => {
              if ("all" in change) {
                changed = true;
                return;
              }
              if (!lookupKeys.some((keys) => keys.has(change.sessionKey))) return;
              try {
                const physicalPath = change.storePath
                  ? captureSessionStoreReadCandidate(
                      resolveUnsuffixedSqliteTargetFromSessionStorePath(change.storePath).path,
                    ).physicalPath
                  : undefined;
                changed ||= selected.some(
                  (item, index) =>
                    lookupKeys[index]!.has(change.sessionKey) &&
                    (!physicalPath || physicalPath === item.physicalPath),
                );
              } catch {
                changed = true;
              }
            });
            try {
              const entries: Array<InternalSessionEntry | undefined> = [];
              for (const item of selected) {
                const ordinal = durable.indexOf(item);
                if (ordinal < 0) {
                  entries.push(undefined);
                  continue;
                }
                const result = await owners[ordinal]!.readExactEntries({
                  sessionKeys: [item.resolved.sessionKey],
                  selection: "logical",
                });
                entries.push(result.entries[0]?.entry);
                assertCurrent();
                if (changed) throw new Error("Session entry changed during read");
              }
              // Process-owned incognito handles cannot be reopened by durable workers.
              // Read them only in the final consuming frame, with no worker-error fallback.
              for (const [index, item] of selected.entries()) {
                if (!durable.includes(item))
                  entries[index] = loadSessionEntryReadOnly(item.captured.scope);
              }
              assertCurrent();
              if (changed) throw new Error("Session entry changed during read");
              return consumeSync(entries);
            } finally {
              unsubscribe();
            }
          },
        ),
    );
  };
  const select = async (index: number): Promise<T> => {
    const item = captured[index];
    if (!item) return await readAll();
    return await withSessionHistoryWorkerReadCandidates(item.candidates, async (custody) => {
      let resolved = item.resolved;
      let assertRegistryCurrent: (() => void) | undefined;
      if (!resolved) {
        const request = { ...item.inventory!, exactScope: item.scope };
        let inventory = await custody.readTargetInventory({
          ...request,
          registeredDatabases: { status: "deferred" },
        });
        if (inventory.kind === "session-target-registry-required") {
          const registry = await item.registry!.read();
          assertRegistryCurrent = registry.assertCurrent;
          registry.assertCurrent();
          custody.assertCurrent();
          inventory = await custody.readTargetInventory({
            ...request,
            registeredDatabases:
              registry.result.status === "available"
                ? registry.result.entries
                : { status: "unavailable" },
          });
        }
        if (inventory.kind !== "session-target-inventory" || !inventory.exactScope)
          throw new Error("Session target worker did not resolve the exact session scope");
        resolved = inventory.exactScope;
      }
      const physicalPath = assertSessionStoreReadCandidate(resolved.path!, item.candidates);
      selected.push({
        captured: item,
        resolved,
        physicalPath,
        assertCurrent: () => {
          assertRegistryCurrent?.();
          custody.assertCurrent();
          for (const candidate of item.candidates)
            assertSessionStoreReadCandidate(candidate.path, item.candidates);
        },
      });
      return await select(index + 1);
    });
  };
  return await select(0);
}
