import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import type { SessionStoreTarget as ResolvedSessionStoreTarget } from "../config/sessions/targets.js";
import { prepareLegacyAcpMigrationSource } from "../infra/legacy-acp-migration-source.js";
import {
  assertMigrationArtifactFingerprint,
  readMigrationArtifactFingerprint,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  type MigrationArtifactFingerprint,
  type MigrationArtifactIdentity,
} from "../infra/session-sqlite-migration-artifact.js";
import { canonicalMigrationFilePath } from "../infra/session-sqlite-migration-manifest.js";
import {
  countTranscriptEventsForPath,
  createTranscriptEventReader,
  readOnlySqliteValidationSnapshot,
  readTranscriptFingerprint,
  type ReadOnlySqliteValidationSnapshot,
} from "../infra/session-sqlite-migration-readers.js";
import type { LegacySessionRecord } from "./doctor-session-sqlite-discovery.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

const SESSION_IMPORT_BATCH_SIZE = 256;

export async function importLegacySessionRecords(
  target: SessionStoreTarget,
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
  replayRetainedPaths: Set<string>,
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  const completedIndexIdentity = records.find((record) => record.completedIndexReplay)
    ?.completedIndexReplay?.indexIdentity;
  if (
    completedIndexIdentity &&
    records.some(
      (record) =>
        record.completedIndexReplay &&
        !sameMigrationArtifact(record.completedIndexReplay.indexIdentity, completedIndexIdentity),
    )
  ) {
    throw new Error("Completed replay rows do not share one legacy index identity");
  }
  const completedIndexFingerprint = completedIndexIdentity
    ? readMigrationArtifactFingerprint(target.storePath)
    : undefined;
  if (
    completedIndexIdentity &&
    completedIndexFingerprint &&
    !sameMigrationArtifact(
      readMigrationArtifactIdentity(target.storePath, 1n, completedIndexFingerprint),
      completedIndexIdentity,
    )
  ) {
    throw new Error("Restored legacy index no longer matches its completed import receipt");
  }
  const assertCompletedIndexCurrent = completedIndexFingerprint
    ? () => assertMigrationArtifactFingerprint(target.storePath, completedIndexFingerprint)
    : undefined;
  const importedTranscriptSources = new Set<string>();
  const existingSnapshot = readOnlySqliteValidationSnapshot(target);
  for (let offset = 0; offset < records.length; offset += SESSION_IMPORT_BATCH_SIZE) {
    const completedReplaySources = new Map<
      string,
      {
        fingerprint: MigrationArtifactFingerprint;
        identity: MigrationArtifactIdentity;
        key: string;
        result?: ReturnType<typeof countTranscriptEventsForPath>;
      }
    >();
    const pending = records.slice(offset, offset + SESSION_IMPORT_BATCH_SIZE).flatMap((record) => {
      const completedTranscriptIdentity =
        record.completedIndexReplay && record.transcriptPath
          ? record.completedIndexReplay.verifiedTranscriptIdentities.get(
              canonicalMigrationFilePath(record.transcriptPath),
            )
          : undefined;
      const completedReplaySourceKey =
        completedTranscriptIdentity && record.transcriptPath
          ? `${record.entry.sessionId}\0${canonicalMigrationFilePath(record.transcriptPath)}`
          : undefined;
      let completedReplaySource = completedReplaySourceKey
        ? completedReplaySources.get(completedReplaySourceKey)
        : undefined;
      const readCompletedReplaySource =
        completedReplaySourceKey !== undefined && completedReplaySource === undefined;
      if (
        completedTranscriptIdentity &&
        record.transcriptPath &&
        completedReplaySourceKey &&
        !completedReplaySource
      ) {
        try {
          const fingerprint = readMigrationArtifactFingerprint(record.transcriptPath);
          if (
            sameMigrationArtifact(
              readMigrationArtifactIdentity(record.transcriptPath, 1n, fingerprint),
              completedTranscriptIdentity,
            )
          ) {
            completedReplaySource = {
              fingerprint,
              identity: completedTranscriptIdentity,
              key: completedReplaySourceKey,
            };
            completedReplaySources.set(completedReplaySourceKey, completedReplaySource);
          }
        } catch {
          completedReplaySource = undefined;
        }
      }
      if (
        record.completedIndexReplay &&
        record.transcriptPath &&
        (!completedTranscriptIdentity ||
          !completedReplaySource ||
          !sameMigrationArtifact(completedReplaySource.identity, completedTranscriptIdentity))
      ) {
        record.completedIndexReplay.outcome = "unverified-source";
        replayRetainedPaths.add(target.storePath);
        for (const source of record.transcriptDependencies) {
          replayRetainedPaths.add(source);
        }
        replayRetainedPaths.add(record.transcriptPath);
        report.issues.push({
          code: "historical_transcript_deferred",
          sessionKey: record.sessionKey,
          message: `${record.transcriptPath}: restored transcript has no matching completed import receipt; canonical session and source were preserved without replay.`,
        });
        return [];
      }
      const prepared = prepareLegacySessionImport(
        target,
        record,
        report,
        importedTranscriptSources,
        existingSnapshot.ok ? existingSnapshot.snapshot : undefined,
        completedReplaySource,
        readCompletedReplaySource,
      );
      return prepared ? [{ ...prepared, record }] : [];
    });
    const pendingParams = pending.map((entry) => entry.params);
    if (assertCompletedIndexCurrent && pendingParams[0]) {
      const beforePersistentApply = pendingParams[0].beforePersistentApply;
      pendingParams[0] = {
        ...pendingParams[0],
        beforePersistentApply: () => {
          assertCompletedIndexCurrent();
          beforePersistentApply?.();
        },
      };
    }
    const imported = await importSqliteSessionRowsBatch(pendingParams);
    for (const [index, result] of imported.entries()) {
      const record = pending[index]?.record;
      if (record?.completedIndexReplay && result.completedIndexReplay) {
        record.completedIndexReplay.outcome = result.completedIndexReplay;
        if (
          result.completedIndexReplay !== "appended" &&
          result.completedIndexReplay !== "unchanged"
        ) {
          replayRetainedPaths.add(target.storePath);
          for (const source of record.transcriptDependencies) {
            replayRetainedPaths.add(source);
          }
          if (record.transcriptPath) {
            replayRetainedPaths.add(record.transcriptPath);
          }
          const reason =
            result.completedIndexReplay === "history-not-appendable"
              ? "is not an ordered suffix of current canonical history"
              : `belongs to a ${result.completedIndexReplay.replaceAll("-", " ")} canonical session`;
          report.issues.push({
            code: "historical_transcript_deferred",
            sessionKey: record.sessionKey,
            message: `${record.sessionKey}: restored history ${reason}; current owner and source were preserved without replay.`,
          });
        }
      }
      if (record && result.recovery) {
        record.recovery = result.recovery;
      }
    }
    report.importedEntries += imported.filter(
      (result) => result.completedIndexReplay === undefined,
    ).length;
    report.importedTranscriptEvents += imported.reduce(
      (total, result) => total + result.transcriptEvents,
      0,
    );
    report.issues.push(...pending.flatMap((entry) => (entry.issue ? [entry.issue] : [])));
    await setImmediate();
  }
}

function prepareLegacySessionImport(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  importedTranscriptSources: Set<string>,
  existingSnapshot: ReadOnlySqliteValidationSnapshot | undefined,
  completedReplaySource?: {
    fingerprint: MigrationArtifactFingerprint;
    identity: MigrationArtifactIdentity;
    key: string;
    result?: ReturnType<typeof countTranscriptEventsForPath>;
  },
  readCompletedReplaySource = false,
) {
  if (
    record.historical &&
    record.transcriptPath &&
    !sameMigrationArtifact(
      record.historical.identity,
      readMigrationArtifactIdentity(record.transcriptPath),
    )
  ) {
    report.issues.push({
      code: "historical_transcript_deferred",
      sessionKey: record.sessionKey,
      message: `${record.historical.originalPath}: source changed after discovery; retained without importing`,
    });
    return undefined;
  }
  const transcriptSourceKey = record.transcriptPath
    ? `${record.entry.sessionId}\0${record.transcriptPath}`
    : undefined;
  const shouldReadTranscript =
    readCompletedReplaySource ||
    (completedReplaySource === undefined &&
      transcriptSourceKey !== undefined &&
      !importedTranscriptSources.has(transcriptSourceKey));
  const transcriptFingerprint =
    completedReplaySource?.fingerprint ??
    (shouldReadTranscript && record.transcriptPath && fs.existsSync(record.transcriptPath)
      ? readTranscriptFingerprint(record.transcriptPath)
      : undefined);
  record.sourceFingerprint = transcriptFingerprint;
  const result =
    completedReplaySource?.result ?? countTranscriptEventsForPath(record.transcriptPath);
  if (completedReplaySource && !completedReplaySource.result) {
    completedReplaySource.result = result;
  }
  const transcriptMtimeMs = readLegacyTranscriptMtimeMs(record);
  const acpEntry = !record.historical
    ? normalizePersistedSessionEntryShape(record.entry, { sessionKey: record.sessionKey })
    : undefined;
  const params = {
    ...(readCompletedReplaySource && completedReplaySource && record.transcriptPath
      ? {
          beforePersistentApply: () => {
            assertMigrationArtifactFingerprint(
              record.transcriptPath!,
              completedReplaySource.fingerprint,
            );
          },
        }
      : {}),
    historicalOnly: Boolean(record.historical),
    completedIndexReplay: Boolean(record.completedIndexReplay),
    ...(completedReplaySource ? { completedReplaySourceKey: completedReplaySource.key } : {}),
    allowMalformedRowRepair: true,
    repairLegacyTranscript: true,
    agentId: target.agentId,
    entry: record.entry,
    ...(acpEntry?.acp
      ? {
          legacyAcpMigrationSource: prepareLegacyAcpMigrationSource({
            sourcePath: target.storePath,
            sourceSessionKey: record.sessionKey,
            sessionId: acpEntry.sessionId,
            lifecycleRevision: acpEntry.lifecycleRevision,
            meta: acpEntry.acp,
          }),
        }
      : {}),
    preserveExactStoredKey: true,
    sessionKey: record.sessionKey,
    storePath: target.sqlitePath ?? target.storePath,
  };
  if (result.status === "missing") {
    if (markAlreadyMigratedTranscript(record, report, existingSnapshot)) {
      return undefined;
    }
    return {
      issue: {
        code: "transcript_missing",
        message: `Transcript file is missing: ${record.transcriptPath}`,
        sessionKey: record.sessionKey,
      },
      params,
    };
  }
  if (transcriptSourceKey) {
    importedTranscriptSources.add(transcriptSourceKey);
  }
  return {
    ...(result.status === "malformed"
      ? {
          issue: {
            code: "transcript_malformed" as const,
            message: result.message,
            sessionKey: record.sessionKey,
          },
        }
      : {}),
    params: {
      ...params,
      ...(shouldReadTranscript && record.transcriptPath && transcriptFingerprint
        ? {
            readTranscriptEvents: createTranscriptEventReader(
              record.transcriptPath,
              record.entry.sessionId,
              result.status === "malformed",
              transcriptFingerprint,
              record.historical?.originalPath ?? record.transcriptPath,
            ),
          }
        : {}),
      ...(transcriptMtimeMs !== undefined ? { transcriptMtimeMs } : {}),
    },
  };
}

function markAlreadyMigratedTranscript(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  snapshot: ReadOnlySqliteValidationSnapshot | undefined,
): boolean {
  const migratedEvents = countAlreadyMigratedTranscriptEventsForImport(snapshot, record);
  if (migratedEvents === undefined) {
    return false;
  }
  report.validatedEntries += 1;
  report.validatedTranscriptEvents += migratedEvents;
  return true;
}

function countAlreadyMigratedTranscriptEventsForImport(
  snapshot: ReadOnlySqliteValidationSnapshot | undefined,
  record: LegacySessionRecord,
): number | undefined {
  if (!snapshot) {
    return undefined;
  }
  const normalizedKey = record.sessionKey;
  if (snapshot.sessionIdsBySessionKey.get(normalizedKey) !== record.entry.sessionId) {
    return undefined;
  }
  return snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
}

function readLegacyTranscriptMtimeMs(record: LegacySessionRecord): number | undefined {
  if (!record.transcriptPath) {
    return undefined;
  }
  try {
    const mtimeMs = Math.floor(fs.statSync(record.transcriptPath).mtimeMs);
    return Number.isFinite(mtimeMs) && mtimeMs >= 0 ? mtimeMs : undefined;
  } catch {
    return undefined;
  }
}
