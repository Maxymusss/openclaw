/** Publishes Doctor-owned legacy session archive plans and receipts. */
import fs from "node:fs";
import path from "node:path";
import {
  resolveTrajectoryPath,
  resolveTrajectoryPointerPath,
} from "../config/sessions/artifacts.js";
import { DeferredPluginMigrationConflictError } from "../infra/deferred-plugin-migrations.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  moveMigrationArtifact,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  HISTORICAL_IMPORT_REASON,
  assertSafeSessionSqliteMigrationMove,
  canonicalMigrationFilePath,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMoves,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  planImportedTranscriptArtifactsToArchive,
  planSessionJsonlArchiveMove,
} from "./doctor-session-sqlite-archive.js";
import {
  gatherLegacyArchiveCoverage,
  listUnreferencedJsonlFiles,
} from "./doctor-session-sqlite-discovery.js";
import {
  countBlockingSessionSqliteIssues,
  type LegacyArchiveTarget,
} from "./doctor-session-sqlite-types.js";

export async function archiveLegacyArtifacts(
  owners: readonly LegacyArchiveTarget[],
  coverage: ReturnType<typeof gatherLegacyArchiveCoverage>,
  activeRun: ActiveSessionSqliteMigrationRun,
  assertCurrent?: () => void,
  capturedSources?: ReadonlySet<string>,
  publishSourceRemoval?: (remove: () => void, retainSource: () => void) => void,
): Promise<void> {
  const {
    selectedStorePaths,
    referencedPaths,
    retainedPaths,
    incompleteDirectories,
    retainedDirectories,
  } = coverage;
  const references = new Map<
    string,
    Array<{ owner: LegacyArchiveTarget; record: LegacyArchiveTarget["records"][number] }>
  >();
  for (const owner of owners) {
    if (!owner.validated || countBlockingSessionSqliteIssues(owner.report) > 0) {
      selectedStorePaths.delete(owner.target.storePath);
    }
    for (const record of owner.records) {
      if (!record.transcriptPath) {
        continue;
      }
      const source = canonicalMigrationFilePath(record.transcriptPath);
      references.set(source, [...(references.get(source) ?? []), { owner, record }]);
    }
  }
  // A retained index needs all its originals. Propagate through shared sources before planning,
  // so a direct retry cannot strand a sibling archive without its index.
  const retainedSources = [...references]
    .filter(
      ([source, refs]) =>
        retainedPaths.has(source) ||
        retainedDirectories.has(path.dirname(source)) ||
        refs.some(({ owner }) => !selectedStorePaths.has(owner.target.storePath)),
    )
    .map(([source]) => source);
  for (const source of retainedSources) {
    for (const file of [
      source,
      resolveTrajectoryPath(source),
      resolveTrajectoryPointerPath(source),
    ]) {
      if (file) {
        retainedPaths.add(file);
      }
    }
    for (const { owner } of references.get(source) ?? []) {
      const storePath = owner.target.storePath;
      if (!selectedStorePaths.delete(storePath)) {
        continue;
      }
      for (const sibling of owners.filter((item) => item.target.storePath === storePath)) {
        for (const record of sibling.records) {
          if (!record.transcriptPath) {
            continue;
          }
          const siblingSource = canonicalMigrationFilePath(record.transcriptPath);
          if (!retainedPaths.has(siblingSource)) {
            retainedPaths.add(siblingSource);
            retainedSources.push(siblingSource);
          }
        }
      }
    }
  }
  const reservedArchivePaths = new Set<string>();
  const planned = new Map<
    string,
    {
      move: SessionSqliteMigrationMove;
      owners: Map<LegacyArchiveTarget, string | undefined>;
      published: boolean;
    }
  >();
  const recordFailure = (
    owner: LegacyArchiveTarget,
    source: string,
    error: unknown,
    unreferenced = false,
  ) => {
    owner.report.issues.push({
      code: unreferenced ? "unreferenced_jsonl_archive_failed" : "transcript_archive_failed",
      message: `${source}: ${formatErrorMessage(error)}`,
    });
  };
  for (const [source, refs] of references) {
    const first = refs[0]!;
    const adopted = refs.flatMap(({ owner, record }) => {
      const move = record.completedIndexReplay?.verifyOnlyTranscriptArchives.get(source);
      return move &&
        record.completedIndexReplay?.outcome === "unchanged" &&
        record.recovery?.complete &&
        owner.validated &&
        selectedStorePaths.has(owner.target.storePath) &&
        countBlockingSessionSqliteIssues(owner.report) === 0
        ? [{ move, owner, sessionKey: record.sessionKey }]
        : [];
    });
    if (adopted.length > 0) {
      try {
        if (statMigrationPath(source) !== undefined) {
          throw new Error("Verified transcript source reappeared before replay settlement");
        }
      } catch (error) {
        for (const owner of new Set(refs.map((ref) => ref.owner))) {
          recordFailure(owner, source, error);
        }
        continue;
      }
      const move = adopted[0]?.move;
      if (
        move?.artifact &&
        adopted.length === refs.length &&
        adopted.every(
          (item) =>
            item.move.archivePath === move.archivePath &&
            sameMigrationArtifact(item.move.artifact!.identity, move.artifact!.identity),
        )
      ) {
        planned.set(source, {
          move: {
            ...move,
            artifact: { ...move.artifact, dependencies: [] },
          },
          owners: new Map(adopted.map(({ owner, sessionKey }) => [owner, sessionKey] as const)),
          published: true,
        });
        continue;
      }
      for (const owner of new Set(refs.map((ref) => ref.owner))) {
        recordFailure(owner, source, "Verified replay archive ownership is ambiguous");
      }
      continue;
    }
    if (!fs.existsSync(source)) {
      // Only initially missing sources may be skipped. Losing an admitted original must
      // protect every referencing index and its remaining recovery dependencies.
      if (refs.some(({ record }) => record.sourceFingerprint)) {
        for (const owner of new Set(refs.map((ref) => ref.owner))) {
          recordFailure(owner, source, "Imported transcript disappeared before archival");
        }
      }
      continue;
    }
    if (retainedPaths.has(source) || retainedDirectories.has(path.dirname(source))) {
      for (const { owner, record } of refs) {
        if (
          countBlockingSessionSqliteIssues(owner.report) === 0 &&
          owner.deferredPluginIds.length === 0
        ) {
          owner.report.issues.push({
            code: "transcript_archive_deferred",
            message: `${source}: retaining the original for an incomplete or unselected importing owner; rerun import for all known owners after resolving their index/import issues.`,
            sessionKey: record.sessionKey,
          });
        }
      }
      continue;
    }
    try {
      const moves = planImportedTranscriptArtifactsToArchive(
        first.owner.target,
        first.record.sessionKey,
        source,
        reservedArchivePaths,
        capturedSources,
      );
      // Same-session aliases reuse the actual importer evidence only within their validated target.
      const imports = refs.map(({ owner, record }) =>
        record.sourceFingerprint
          ? record
          : refs.find(
              (ref) =>
                ref.owner === owner &&
                ref.record.sessionId === record.sessionId &&
                ref.record.sourceFingerprint,
            )?.record,
      );
      const fingerprints = imports.flatMap((record) =>
        record?.sourceFingerprint ? [record.sourceFingerprint] : [],
      );
      const fingerprint = fingerprints[0];
      if (
        fingerprint &&
        fingerprints.some((current) =>
          (["ctimeNs", "dev", "ino", "mtimeNs", "size"] as const).some(
            (key) => current[key] !== fingerprint[key],
          ),
        )
      ) {
        throw new Error("Transcript changed between imports; retaining the unverified original");
      }
      const complete =
        !incompleteDirectories.has(path.dirname(source)) &&
        imports.every((record) => record?.sourceFingerprint && record.recovery?.complete) &&
        refs.every(
          ({ owner, record }) =>
            !owner.report.issues.some(
              (issue) =>
                issue.code === "transcript_malformed" && issue.sessionKey === record.sessionKey,
            ),
        );
      for (const move of moves) {
        if (retainedPaths.has(move.sourcePath)) {
          throw new Error("Artifact is required by an incomplete importing owner");
        }
        move.artifact = {
          identity: readMigrationArtifactIdentity(
            move.sourcePath,
            1n,
            move.kind === "transcript" ? fingerprint : undefined,
          ),
          classification:
            complete && move.kind === "transcript" && !first.record.historical
              ? imports.some((record) => record?.recovery?.repaired)
                ? "repair-original"
                : "imported"
              : "protected",
          reason:
            complete && first.record.historical && move.kind === "transcript"
              ? HISTORICAL_IMPORT_REASON
              : complete && move.kind === "transcript"
                ? "verified-import-original"
                : "unimported-or-unknown-history",
          dependencies: [],
          disposal: { state: "retained" },
        };
        const existing = planned.get(move.sourcePath);
        if (existing) {
          if (move.artifact.classification === "protected") {
            existing.move.artifact = move.artifact;
          }
          for (const ref of refs) {
            existing.owners.set(ref.owner, ref.record.sessionKey);
          }
        } else {
          planned.set(move.sourcePath, {
            move,
            owners: new Map(refs.map((ref) => [ref.owner, ref.record.sessionKey])),
            published: false,
          });
        }
      }
    } catch (error) {
      for (const owner of new Set(refs.map((ref) => ref.owner))) {
        recordFailure(owner, source, error);
      }
    }
  }
  // Gather all indexed sources and plans before sweeping any directory; another custom index
  // may own a file even when its importer failed or was not selected for this run.
  for (const owner of owners) {
    const storePath = owner.target.storePath;
    if (
      !selectedStorePaths.has(storePath) ||
      countBlockingSessionSqliteIssues(owner.report) > 0 ||
      incompleteDirectories.has(path.dirname(storePath))
    ) {
      continue;
    }
    for (const source of listUnreferencedJsonlFiles(storePath, [
      ...referencedPaths,
      ...planned.keys(),
    ])) {
      if (retainedPaths.has(source)) {
        continue;
      }
      if (capturedSources && !capturedSources.has(source)) {
        continue;
      }
      try {
        const move = planSessionJsonlArchiveMove({
          archiveKey: "archive-tier",
          baseNameRaw: path.basename(source),
          kind: "unreferenced-jsonl",
          reservedArchivePaths,
          sourcePathRaw: source,
          target: owner.target,
        });
        move.artifact = {
          identity: readMigrationArtifactIdentity(source),
          classification: "protected",
          reason: "unreferenced-history",
          dependencies: [],
          disposal: { state: "retained" },
        };
        reservedArchivePaths.add(move.archivePath);
        planned.set(source, {
          move,
          owners: new Map([[owner, undefined]]),
          published: false,
        });
      } catch (error) {
        recordFailure(owner, source, error, true);
      }
    }
  }
  // A physical move must remain resolvable through every receipt that captured its source.
  for (const owner of owners) {
    for (const { path: source } of owner.verifiedSources ?? []) {
      const shared = planned.get(source);
      if (shared && !shared.owners.has(owner)) {
        shared.owners.set(owner, undefined);
      }
    }
  }
  const movesForOwner = (owner: LegacyArchiveTarget) =>
    [...planned.values()]
      .filter((item) => item.owners.has(owner))
      .map(({ move, owners: refs }) => Object.assign({}, move, { sessionKey: refs.get(owner) }));
  // Every referencing target gets its own session key and shared mapping before publication.
  for (const owner of owners) {
    assertCurrent?.();
    recordPlannedMigrationMoves(activeRun, owner.target, movesForOwner(owner));
  }
  const completed = new Set<string>();
  for (const { move, owners: referencingOwners, published } of planned.values()) {
    try {
      if (published) {
        if (
          statMigrationPath(move.sourcePath) !== undefined ||
          !sameMigrationArtifact(
            readMigrationArtifactIdentity(move.archivePath),
            move.artifact!.identity,
          )
        ) {
          throw new Error("Verified transcript archive changed before replay settlement");
        }
      } else {
        for (const owner of referencingOwners.keys()) {
          assertSafeSessionSqliteMigrationMove(move, owner.target);
        }
        assertCurrent?.();
        await moveMigrationArtifact(
          move.sourcePath,
          move.archivePath,
          move.artifact!.identity,
          assertCurrent
            ? () => {
                assertCurrent();
              }
            : undefined,
          publishSourceRemoval,
        );
      }
      assertCurrent?.();
      completed.add(move.sourcePath);
      for (const { report } of referencingOwners.keys()) {
        (move.kind === "unreferenced-jsonl"
          ? report.archivedUnreferencedJsonlFiles
          : report.archivedTranscriptFiles
        ).push(move.archivePath);
      }
    } catch (error) {
      if (error instanceof DeferredPluginMigrationConflictError && error.pending.length > 0) {
        break;
      }
      for (const owner of referencingOwners.keys()) {
        recordFailure(owner, move.sourcePath, error, move.kind === "unreferenced-jsonl");
      }
    }
  }
  for (const owner of owners) {
    assertCurrent?.();
    recordCompletedMigrationMoves(
      activeRun,
      owner.target,
      movesForOwner(owner).filter((move) => completed.has(move.sourcePath)),
    );
    owner.report.unreferencedJsonlFiles = listUnreferencedJsonlFiles(owner.target.storePath, [
      ...referencedPaths,
    ]);
  }
}
