import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { readAcpSessionMetaForEntriesInWorker } from "../acp/runtime/session-meta-readonly.js";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { loadCombinedSessionStoreForGatewayCoreAsync } from "../config/sessions/combined-store-gateway.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { resolveSessionKeyBySessionId } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { retainUserProfileCatalog } from "../state/user-profile-list.js";
import type { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import { yieldSessionListWork } from "./session-projection-work.js";
import { readSessionRowModelFacts } from "./session-row-model-facts.js";
import { withPreparedSessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import { readSessionRowAncestors } from "./session-row-projection-ancestors.js";
import {
  createSessionRowProjectionArchive,
  isColdArchivedSessionRow as isCold,
} from "./session-row-projection-archive.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import { createSessionRowProjectionCatalog } from "./session-row-projection-catalog.js";
import { createSessionRowProjectionContext } from "./session-row-projection-context.js";
import { createSessionRowCreatorIndex } from "./session-row-projection-identities.js";
import {
  createSessionRowMaterializationBatch,
  readIncognitoSessionRow,
  readResidentSessionRow,
} from "./session-row-projection-materialize.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowProjectionTranscriptUpdates } from "./session-row-projection-transcript.js";
import {
  createSessionRowScopeMatcher,
  prepareSessionRowScopes,
  selectMatchingSessionRows,
  selectSessionRowEntries,
} from "./session-row-scope.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";

/** Committed publications own invalidation; each admitted physical store is hydrated once. */
export async function createSessionRowProjection(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  modelCatalog?: records.Inputs["modelCatalog"];
  getModelCatalog?: () => Promise<records.Inputs["modelCatalog"]>;
  context?: Parameters<typeof readSessionRowFacts>[0]["context"];
  placementFactsReader?: Parameters<typeof readSessionRowFacts>[0]["placementFactsReader"];
}) {
  // Publications may borrow startup admission; projection work retains its own authority.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let cfg = params.cfg;
  const rows = new Map<string, records.Row>();
  const creators = createSessionRowCreatorIndex();
  let stores = new Map<
    string,
    { target: SessionStoreTarget; agentId: string; identity: string | symbol; filename: string }
  >();
  const byStore = new Map<string, Set<string>>(),
    byAgent = new Map<string, Set<string>>();
  const byParent = new Map<string, Set<string>>(),
    byKey = new Map<string, Set<string>>();
  const indexes = { byStore, byAgent, byParent, byKey };
  const dirty = new Set<string>();
  let topologyDirty = true,
    disposed = false;
  let epoch = 0;
  let rowRevision = 0;
  let materializedCount = 0;
  let scope: ReturnType<typeof prepareSessionRowScopes>;
  let pending: Promise<void> | undefined;
  const catalog = createSessionRowProjectionCatalog({
    modelCatalog: params.modelCatalog,
    getModelCatalog: params.getModelCatalog,
    onInvalidated: () => mark({ all: true, scope: "catalog" }),
    onRefreshed(changed) {
      if (changed) {
        // Rows served during renewal need new materializations only when their model facts changed.
        epoch++;
        metadata.invalidate({ all: true, scope: "catalog" });
        archive.invalidateRows({ all: true, scope: "catalog" }, rows.values());
      }
      void ensureMaterialized().catch(() => {});
    },
  });
  const metadata = createSessionRowProjectionContext();
  const backfill = createSessionRowProjectionBackfill({
    ready: ensureMaterialized,
    read: (id) => rows.get(id),
    current: (row) =>
      !topologyDirty &&
      !dirty.has(records.identity(row)) &&
      archive.isCurrentMaterialization(row) &&
      isCurrent(row),
    publish(row, fields) {
      const current = rows.get(records.identity(row));
      if (
        current?.materialized &&
        (current.lastMessagePreview !== fields.lastMessagePreview ||
          !isDeepStrictEqual(current.fallbackModel, fields.fallbackModel))
      ) {
        Object.assign(current, {
          lastMessagePreview: fields.lastMessagePreview,
          fallbackModel: fields.fallbackModel,
        });
        dirty.add(records.identity(current));
        void ensureMaterialized().catch(() => {});
      }
    },
  });
  const archive = createSessionRowProjectionArchive({
    rows,
    dirty,
    put,
    enqueue: (id, change) => backfill.enqueue(id, change),
    release(id) {
      transcriptUpdates.remove(id);
      backfill.remove(id);
      dirty.delete(id);
    },
  });
  const markRelated = (row: records.Row) => archive.markRelated(row, indexes);
  function remove(id: string) {
    archive.forget(id);
    transcriptUpdates.remove(id);
    const row = rows.get(id);
    if (row) {
      rowRevision++;
      markRelated(row);
      creators.update(row);
      records.index(row, indexes, true);
      rows.delete(id);
    }
    dirty.delete(id);
    backfill.remove(id);
  }
  function put(row: records.Row) {
    rowRevision++;
    const previous = rows.get(records.identity(row));
    creators.update(previous, row);
    if (previous) {
      if (previous.generation !== row.generation) {
        transcriptUpdates.remove(records.identity(row));
      }
      records.index(previous, indexes, true);
    }
    rows.set(records.identity(row), row);
    records.index(row, indexes);
  }
  function acquireEntry(row: records.Row, storedEntry: SessionEntry | undefined) {
    if (storedEntry?.archivedAt !== undefined) {
      inOwnerContext(() => metadata.prepare(epoch, cfg, matching, put));
    }
    return records.acquireSessionRowEntry({
      row,
      storedEntry,
      cfg,
      context: metadata.current,
      remove,
      put,
      markRelated,
      archive,
    });
  }
  function matching(query: records.Query, kind = "key") {
    return selectMatchingSessionRows({ rows, indexes, scope }, query, kind);
  }
  function lookup(query: records.Lookup) {
    if (disposed) {
      return undefined;
    }
    const { agentId } = query;
    const exact = matching(query).filter((row) => row.agentId === agentId);
    if (exact.length) {
      return records.first(exact, stores.keys());
    }
    const key = resolveStoredSessionKeyForAgentStore({
      cfg,
      sessionKey: query.key,
      agentId,
    });
    if (isIncognitoSessionKey(key)) {
      return readIncognitoSessionRow({ cfg, key, agentId });
    }
    const candidates = matching({ ...query, key }).filter((row) => row.agentId === agentId);
    return records.first(candidates, stores.keys());
  }
  function referenced(ref: string) {
    return records.first(
      [...(byKey.get(ref) ?? [])].flatMap((id) => rows.get(id) ?? []),
      stores.keys(),
    );
  }
  async function topology() {
    const revision = epoch;
    cfg = params.getConfig?.() ?? cfg;
    const admitted = new Set<string>();
    const nextStores: typeof stores = new Map();
    const replaced = new Set<string>();
    const loaded = await loadCombinedSessionStoreForGatewayCoreAsync(cfg, {
      includeIncognito: false,
      preserveSentinelOwners: "physical",
      async loadEntries(target, projection, owner) {
        const opened = await owner.readExactEntries({ sessionKeys: [] });
        if (!opened.databaseIdentity) {
          return [];
        }
        const databaseIdentity = opened.databaseIdentity.identity;
        const previous =
          stores.get(target.storePath) ??
          [...stores.values()].find((source) => source.identity === databaseIdentity);
        nextStores.set(target.storePath, {
          target,
          agentId: previous?.agentId ?? target.agentId,
          identity: databaseIdentity,
          filename: opened.databaseIdentity.filename,
        });
        if (previous?.identity === databaseIdentity) {
          return [...(byStore.get(previous.target.storePath) ?? [])].flatMap((id) => {
            const row = rows.get(id);
            return row?.storedEntry ? [{ sessionKey: row.key, entry: row.storedEntry }] : [];
          });
        }
        replaced.add(target.storePath);
        return owner.readEntries({ ...target, projection, clone: false });
      },
      onStoreLoaded(target, agentId) {
        const source = nextStores.get(target.storePath);
        if (source) {
          source.agentId = agentId;
        }
      },
    });
    if (disposed || epoch !== revision) {
      return;
    }
    for (const [key, target] of loaded.targetsBySessionKey) {
      const entry = target.entry;
      if (!entry || entry.incognito || isIncognitoSessionKey(key)) {
        continue;
      }
      const fields = {
        key: target.storeKey ?? key,
        agentId: target.agentId,
        storeTarget: target.storeTarget,
      };
      const id = records.identity(fields);
      admitted.add(id);
      if (!rows.has(id) || replaced.has(target.storeTarget.storePath)) {
        remove(id);
        const row = acquireEntry(records.create(fields), entry);
        if (row) {
          dirty.add(id);
          if (!isCold(row)) backfill.enqueue(id);
        }
      } else {
        const row = rows.get(id)!;
        if (row.entry?.archivedAt !== undefined) {
          acquireEntry(row, entry);
        }
      }
    }
    for (const id of rows.keys()) {
      if (!admitted.has(id)) {
        remove(id);
      }
    }
    stores = nextStores;
    scope = prepareSessionRowScopes(
      cfg,
      byAgent.keys(),
      new Map([...stores].map(([locator, source]) => [source.filename, locator])),
    );
    topologyDirty = epoch !== revision;
  }
  function mark(change: SessionRowChange) {
    epoch++;
    const presentationOnly = metadata.invalidate(change);
    if ("all" in change) {
      topologyDirty ||= change.scope === "stores" || change.scope === "config";
      if (change.scope === "catalog" || change.scope === "config") {
        catalog.invalidate();
      }
      // Renewal serves the old catalog until its replacement is adopted.
      if (!presentationOnly && (change.scope !== "catalog" || !params.getModelCatalog)) {
        archive.invalidateRows(
          change,
          typeof change.scope === "string" ? rows.values() : matching(change.scope),
        );
      }
    } else if (change.scope === "automation") {
      records.markAutomation(
        matching({ key: change.sessionKey }).filter((row) => !isCold(row)),
        change.agentId,
        dirty,
      );
    } else {
      const query = { ...change, key: change.sessionKey };
      const exact = matching(query);
      const found = new Set([...exact, ...matching(query, "id")]);
      for (const previous of found) {
        markRelated(previous);
        dirty.add(records.identity(previous));
        backfill.enqueue(records.identity(previous));
      }
      if (
        !exact.length &&
        !isInternalSessionEffectsKey(change.sessionKey) &&
        !isIncognitoSessionKey(change.sessionKey)
      ) {
        const matches = createSessionRowScopeMatcher(change, scope);
        for (const source of stores.values()) {
          const agentId = parseAgentSessionKey(change.sessionKey)?.agentId ?? source.agentId;
          const row = records.create({
            key: change.sessionKey,
            agentId,
            storeTarget: source.target,
          });
          if (!matches(row) || (!change.storePath && agentId !== source.agentId)) {
            continue;
          }
          put(row);
          dirty.add(records.identity(row));
          backfill.enqueue(records.identity(row));
        }
      }
    }
    // Dirty keys retain failed background work for the next reader.
    void ensureMaterialized().catch(() => {});
  }
  function readSourceEntry(row: records.Row, key: string) {
    const source = referenced(
      records.parentReference(cfg, key, row.agentId, row.storeTarget.storePath),
    );
    return source?.storedEntry;
  }
  function readChildLinks(row: records.Row) {
    const links = [...records.dependents(row, byParent)].flatMap((child) => {
      const value = rows.get(child);
      return value?.entry && [...value.parents].some((ref) => referenced(ref) === row)
        ? [{ key: value.key, entry: value.entry }]
        : [];
    });
    // Keyed child refreshes reorder the parent index; presentation must stay stable.
    links.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return links;
  }
  function materialize(
    row: records.Row,
    configuredAgentIds = new Set(listAgentIds(cfg)),
    readRow = readResidentSessionRow,
  ) {
    if (!row.entry) {
      return false;
    }
    const links = readChildLinks(row);
    const prepared = readRow({
      row: { ...row, entry: row.entry },
      cfg,
      modelCatalog: catalog.current,
      configuredAgentIds,
      context: metadata.current,
      subagentInputs: metadata.subagentInputs,
      gatewayContext: params.context,
      placementFactsReader: params.placementFactsReader,
      placementRevision: metadata.placementRevision,
      links,
      readSourceEntry: (key) => readSourceEntry(row, key),
    });
    if (!isIncognitoSessionKey(row.key) && rows.get(records.identity(row)) !== row) {
      return false;
    }
    Object.assign(row, prepared, {
      materializedSequence: ++materializedCount,
      ...metadata.materializedRevisions,
    });
    return true;
  }
  async function refresh(ids: readonly string[], materializeArchived = false) {
    if (disposed) {
      return;
    }
    // Retain requested rows and their bounded relation neighborhood across worker reads.
    const selected = new Map<string, records.Row>();
    const requested = new Set(ids);
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) continue;
      selected.set(id, row);
    }
    for (const row of selected.values()) {
      for (const child of records.dependents(row, byParent)) {
        const value = rows.get(child);
        if (value && dirty.has(child)) selected.set(child, value);
      }
      for (const ref of row.parents) {
        const value = referenced(ref);
        if (value && dirty.has(records.identity(value)))
          selected.set(records.identity(value), value);
      }
    }
    const revision = epoch;
    const groups = new Map<string, records.Row[]>();
    for (const row of selected.values()) {
      const group = groups.get(row.storeTarget.storePath) ?? [];
      group.push(row);
      groups.set(row.storeTarget.storePath, group);
    }
    const prepared = new Map<
      string,
      {
        entry: SessionEntry | undefined;
        membership: Set<string>;
        hasBoard: boolean;
        watermark: records.Row["transcriptWatermark"];
        acpMeta?: records.Row["preparedAcpMeta"];
      }
    >();
    const groupedRows = [...groups.values()];
    await withSessionHistoryWorkerDatabases(
      groupedRows.map(([row]) => ({
        agentId: row!.storeTarget.agentId,
        path: row!.storeTarget.storePath,
      })),
      async (owners) => {
        for (const [index, group] of groupedRows.entries()) {
          const owner = owners[index]!;
          for (let offset = 0; offset < group.length; offset += 64) {
            const batch = group.slice(offset, offset + 64);
            const result = await owner.readExactEntries({
              sessionKeys: batch.map((row) => row.key),
              projection: "list",
              includeProjectionFacts: true,
            });
            const entries = new Map(
              result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
            );
            for (const row of batch) {
              const members = entries.has(row.key)
                ? await owner.readMembers({
                    sessionKey: row.key,
                    env: { ...cloneEnvWithPlatformSemantics(process.env) },
                  })
                : [];
              prepared.set(records.identity(row), {
                entry: entries.get(row.key),
                hasBoard: result.boardSessionKeys?.includes(row.key) ?? false,
                watermark: result.transcriptWatermarks?.find(
                  (value) => value.sessionKey === row.key,
                )?.watermark,
                membership: new Set(members.map((member) => member.identityId)),
              });
            }
          }
        }
        const acpRows = [...selected].flatMap(([id, row]) => {
          const entry = prepared.get(id)?.entry;
          return entry ? [{ id, sessionKey: row.key, agentId: row.agentId, entry }] : [];
        });
        const acpMetadata = await readAcpSessionMetaForEntriesInWorker({ cfg, entries: acpRows });
        for (const [index, { id }] of acpRows.entries()) {
          prepared.get(id)!.acpMeta = acpMetadata[index] ?? null;
        }
        for (const owner of owners) owner.assertCurrent();
        if (
          disposed ||
          epoch !== revision ||
          [...selected].some(([id, row]) => rows.get(id) !== row)
        ) {
          return;
        }
        withAgentRosterFactsBatch(cfg, () => {
          metadata.prepare(epoch, cfg, matching, put);
          const acquired: records.Row[] = [];
          for (const [id, previous] of selected) {
            const facts = prepared.get(id)!;
            const row = acquireEntry(
              {
                ...previous,
                hasBoard: facts.hasBoard,
                transcriptWatermark: facts.watermark,
                preparedAcpMeta: facts.acpMeta,
              },
              facts.entry,
            );
            if (row) {
              row.membership = facts.membership;
              acquired.push(row);
            }
          }
          // A committed reparent can introduce another dirty source after acquisition.
          // Reuse the next exact refresh before deriving any graph from mixed generations.
          const missingDependency = acquired.some((row) => {
            const related = [
              ...records.dependents(row, byParent),
              ...[...row.parents].flatMap((ref) => {
                const source = referenced(ref);
                return source ? [records.identity(source)] : [];
              }),
            ];
            return related.some((id) => dirty.has(id) && !selected.has(id));
          });
          if (missingDependency) {
            for (const row of acquired) dirty.add(records.identity(row));
            return;
          }
          const configuredAgentIds = new Set(listAgentIds(cfg));
          const readRow = createSessionRowMaterializationBatch();
          for (const row of acquired) {
            const id = records.identity(row);
            const materializeRequestedArchive = materializeArchived && requested.has(id);
            if (isCold(row) && !materializeRequestedArchive) {
              dirty.delete(id);
              backfill.remove(id);
            } else if (materialize(row, configuredAgentIds, readRow)) {
              dirty.delete(id);
              if (materializeRequestedArchive && row.entry?.archivedAt !== undefined)
                backfill.enqueue(id);
            }
          }
        });
      },
    );
  }
  async function refreshBatch() {
    if (topologyDirty) {
      await topology();
      if (topologyDirty || disposed) return;
    }
    if (catalog.needsInitialRead) {
      await catalog.refresh();
    }
    await refresh([...dirty].slice(0, 64));
  }
  function needsMaterialization() {
    return !disposed && (topologyDirty || catalog.needsInitialRead || dirty.size > 0);
  }
  async function drain() {
    while (needsMaterialization()) {
      await refreshBatch();
      if (dirty.size || topologyDirty) {
        await yieldSessionListWork();
      }
    }
  }
  function ensureMaterialized(): Promise<void> {
    if (!disposed && !catalog.needsInitialRead) {
      void inOwnerContext(() => catalog.refresh());
    }
    if (!needsMaterialization()) {
      // Adopt already-published catalog reads without waiting for an in-flight renewal.
      return pending ?? (catalog.isRefreshing ? yieldSessionListWork() : Promise.resolve());
    }
    return (pending ??= yieldSessionListWork()
      .then(() => inOwnerContext(drain))
      .then(
        () => {
          pending = undefined;
          if (needsMaterialization()) {
            return ensureMaterialized();
          }
          return undefined;
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      ));
  }
  const transcriptUpdates = createSessionRowProjectionTranscriptUpdates({
    matching,
    mark,
    read: (id) => rows.get(id),
    refresh(id) {
      const row = rows.get(id);
      if (!row || isCold(row)) {
        return;
      }
      epoch++;
      dirty.add(id);
      backfill.enqueue(id);
      void ensureMaterialized().catch(() => {});
    },
  });
  const stop = [
    retainUserProfileCatalog(),
    sessionChanges.subscribe(mark),
    onSessionLifecycleEvent(mark),
    onSessionIdentityMutation((mutation) => {
      for (const key of mutation.previous.sessionKeys) {
        for (const row of matching({ key, agentId: mutation.agentId })) {
          if (mutation.previous.sessionId && row.entry?.sessionId !== mutation.previous.sessionId) {
            continue;
          }
          markRelated(row);
          if ("current" in mutation && mutation.current.sessionKeys.includes(row.key)) {
            put(records.renewGeneration(row));
            dirty.add(records.identity(row));
          } else {
            remove(records.identity(row));
          }
        }
      }
      if ("current" in mutation) {
        for (const sessionKey of mutation.current.sessionKeys) {
          mark({ agentId: mutation.agentId, sessionKey });
        }
      } else {
        void ensureMaterialized().catch(() => {});
      }
    }),
  ];
  function isCurrent(row: records.Row) {
    const current = isIncognitoSessionKey(row.key)
      ? lookup({ ...row, storePath: row.storeTarget.storePath })
      : rows.get(records.identity(row));
    return records.isCurrentGeneration(row, current);
  }
  const describe = (query: records.Lookup, captured?: records.Row) =>
    inOwnerContext(() => {
      if (disposed) {
        return undefined;
      }
      metadata.prepare(epoch, cfg, matching, put);
      let row = lookup(query);
      if (row && isIncognitoSessionKey(row.key)) {
        materialize(row);
      } else {
        if (topologyDirty || (row && (dirty.has(records.identity(row)) || isCold(row)))) {
          return undefined;
        }
        row = archive.describe(row);
      }
      if (captured && !isCurrent(captured)) {
        return undefined;
      }
      if (!records.ready(row)) {
        return undefined;
      }
      metadata.preparePresentation(row, readChildLinks);
      return row;
    });
  function dispose() {
    rowRevision++;
    disposed = true;
    catalog.dispose();
    transcriptUpdates.dispose();
    backfill.dispose();
    for (const unsubscribe of stop) {
      unsubscribe();
    }
    for (const map of [rows, stores, byStore, byAgent, byParent, byKey]) {
      map.clear();
    }
    dirty.clear();
    creators.dispose();
    archive.clear();
  }
  function selectEntries(query: records.Query = {}) {
    if (disposed) {
      return [];
    }
    return inOwnerContext(() => {
      metadata.prepare(epoch, cfg, matching, put);
      return withAgentRosterFactsBatch(cfg, () =>
        selectSessionRowEntries(
          {
            cfg,
            scope,
            byAgent,
            byParent,
            rows,
            dirty,
            matching,
            acquire: (row) => (dirty.has(records.identity(row)) ? undefined : row),
          },
          query,
        ),
      );
    });
  }
  await inOwnerContext(async () => {
    do {
      await refreshBatch();
    } while (topologyDirty && !disposed);
  }).catch((error: unknown) => {
    dispose();
    throw error;
  });
  void ensureMaterialized().catch(() => {});
  backfill.start();
  const projection = {
    capture(query: records.Lookup) {
      return lookup(query);
    },
    findBySessionId(query: { sessionId: string; agentId?: string; storePath?: string }) {
      if (
        !query.agentId ||
        !query.storePath ||
        !isIncognitoOpenClawAgentSqlitePath(query.storePath, { agentId: query.agentId })
      ) {
        return matching({ ...query, key: query.sessionId }, "id");
      }
      const key = !disposed && resolveSessionKeyBySessionId(query);
      const row = key ? lookup({ ...query, agentId: query.agentId, key }) : undefined;
      return row?.entry?.sessionId === query.sessionId ? [row] : [];
    },
    describe,
    readMembership(query: records.Lookup) {
      const row = lookup(query);
      if (row && isIncognitoSessionKey(row.key)) return describe(query)?.membership;
      if (!row || disposed || topologyDirty || dirty.has(records.identity(row))) return undefined;
      return row.membership;
    },
    ancestorRows: (record: records.MaterializedRow) =>
      readSessionRowAncestors(record, { cfg, context: metadata.current, referenced, describe }),
    setArchivePageSize: archive.setPageSize,
    modelFacts(row: records.EntryRow) {
      return readSessionRowModelFacts({
        cfg,
        ...row,
        source: { entry: row.storedEntry, readSourceEntry: (key) => readSourceEntry(row, key) },
        preparedAcpMeta: row.preparedAcpMeta,
        modelCatalog: catalog.current,
        rowContext: metadata.current,
      });
    },
    present: (record: records.MaterializedRow, options?: records.SnapshotOptions) =>
      records.present(record, metadata.current, options),
    needsExactRowsPreparation(queries: readonly records.Lookup[]) {
      return (
        !disposed &&
        (topologyDirty ||
          queries.some((query) => {
            const row = lookup(query);
            return (
              row &&
              !isIncognitoSessionKey(row.key) &&
              (dirty.has(records.identity(row)) || isCold(row))
            );
          }))
      );
    },
    async prepareExactRows(queries: readonly records.Lookup[]) {
      for (;;) {
        if (disposed) throw new Error("Session row read view is no longer active");
        if (topologyDirty) await inOwnerContext(topology);
        if (disposed) throw new Error("Session row read view is no longer active");
        if (topologyDirty) continue;
        const selected = queries.flatMap((query) => {
          const row = lookup(query);
          return row &&
            !isIncognitoSessionKey(row.key) &&
            (dirty.has(records.identity(row)) || isCold(row))
            ? [records.identity(row)]
            : [];
        });
        if (!selected.length) return;
        await inOwnerContext(() => refresh(selected, true));
        if (disposed) throw new Error("Session row read view is no longer active");
        if (selected.every((id) => !dirty.has(id))) return;
      }
    },
    withPreparedExactRows<T>(
      queries: (config: OpenClawConfig) => readonly records.Lookup[],
      consume: (read: SessionRowReadView) => T,
    ): ReturnType<typeof withPreparedSessionRows<T>> {
      return withPreparedSessionRows(projection, () => !disposed, queries, consume);
    },
    ensureMaterialized,
    get materializedCount() {
      return materializedCount;
    },
    get dirtyRowCount() {
      return dirty.size;
    },
    get needsMaterialization() {
      return needsMaterialization();
    },
    get state() {
      if (!disposed) {
        metadata.prepare(epoch, cfg, matching, put);
      }
      return {
        // Include replacements and lifecycle-only removals as well as publications/materialization.
        revision: epoch + rowRevision + materializedCount,
        cfg,
        modelCatalog: catalog.current,
        rowContext: metadata.current,
        scope: scope.select,
      };
    },
    isCurrent,
    selectEntries,
    listCreatedActors: (): ReturnType<typeof creators.list> =>
      inOwnerContext(() => creators.list(projection.state.scope({}).paths, matching)),
    snapshot(query: records.Lookup, options: records.SnapshotOptions = {}) {
      const record = describe(query);
      return record
        ? {
            row: records.present(record, metadata.current, options),
            lifecycleRunId: record.entry.lifecycleRunId,
          }
        : { row: null };
    },
    dispose,
  };
  return projection;
}

export type SessionRowProjection = Awaited<ReturnType<typeof createSessionRowProjection>>;
