import fs from "node:fs";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
  type MigrationArtifactIdentity,
} from "../infra/session-sqlite-migration-artifact.js";
import { isSessionSqliteMigrationWarning } from "../infra/session-sqlite-migration-issues.js";
import {
  canonicalMigrationFilePath,
  migrationMoveKey,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import type { RecoveryArtifactReference } from "./doctor-session-sqlite-recovery-inventory.js";

export type CompletedLegacyStoreReplay = {
  move: SessionSqliteMigrationMove;
  sourceIdentity: MigrationArtifactIdentity;
  target: { agentId: string; sqlitePath: string; storePath: string };
  verifiedTranscriptIdentities: ReadonlyMap<string, MigrationArtifactIdentity>;
  verifyOnlyTranscriptArchives: ReadonlyMap<string, SessionSqliteMigrationMove>;
};

type CompletedMoveEvidence = {
  move: SessionSqliteMigrationMove;
  sourceIdentity: MigrationArtifactIdentity;
  target: RecoveryArtifactReference["target"];
};

function sameMigrationArtifactContent(
  left: Pick<MigrationArtifactIdentity, "sha256" | "size">,
  right: Pick<MigrationArtifactIdentity, "sha256" | "size">,
): boolean {
  return left.sha256 === right.sha256 && left.size === right.size;
}

function sameMigrationTarget(
  left: RecoveryArtifactReference["target"],
  right: RecoveryArtifactReference["target"],
): boolean {
  return (
    left.agentId === right.agentId &&
    left.storePath === right.storePath &&
    left.sqlitePath === right.sqlitePath
  );
}

// A failed run can still durably publish its transcript before its index publication fails.
// Admit that archive only as a unique, receipt-bound verification source for the same target.
function collectVerifyOnlyTranscriptArchives(
  groups: Iterable<readonly RecoveryArtifactReference[]>,
): CompletedMoveEvidence[] {
  const candidates = [...groups];
  const claimCounts = new Map<string, number>();
  const keyFor = (ref: RecoveryArtifactReference) =>
    JSON.stringify([
      ref.target.agentId,
      ref.target.storePath,
      ref.target.sqlitePath,
      ref.move.sourcePath,
    ]);
  for (const refs of candidates) {
    const ref = refs[0];
    let settled = false;
    try {
      settled =
        refs.length > 0 &&
        refs.every(
          (candidate) =>
            candidate.consumedByRestore || candidate.move.artifact?.disposal.state === "disposed",
        ) &&
        statMigrationPath(ref!.move.archivePath) === undefined;
    } catch {
      // Unknown claims remain competing authority and force refusal.
    }
    if (!settled) {
      for (const key of new Set(
        refs.filter((candidate) => candidate.move.kind === "transcript").map(keyFor),
      )) {
        claimCounts.set(key, (claimCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const evidence: CompletedMoveEvidence[] = [];
  for (const refs of candidates) {
    const physical = refs[0]?.move;
    if (
      !physical?.artifact ||
      refs.some(
        (ref) =>
          !ref.trusted ||
          ref.consumedByRestore ||
          ref.move.kind !== "transcript" ||
          ref.move.sourcePath !== physical.sourcePath ||
          !ref.move.artifact ||
          (ref.move.artifact.classification !== "imported" &&
            ref.move.artifact.classification !== "repair-original") ||
          ref.move.artifact.reason !== "verified-import-original" ||
          ref.move.artifact.disposal.state !== "retained" ||
          !sameMigrationArtifact(ref.move.artifact.identity, physical.artifact!.identity),
      )
    ) {
      continue;
    }
    const targetGroups = new Map<string, RecoveryArtifactReference[]>();
    for (const ref of refs) {
      const key = keyFor(ref);
      targetGroups.set(key, [...(targetGroups.get(key) ?? []), ref]);
    }
    for (const [key, targetRefs] of targetGroups) {
      const firstRef = targetRefs[0]!;
      if (firstRef.move.kind !== "transcript" || claimCounts.get(key) !== 1) {
        continue;
      }
      const completed = targetRefs.map((ref) =>
        ref.target.completedMoves.find(
          (move) =>
            migrationMoveKey(move) === migrationMoveKey(ref.move) &&
            move.kind === "transcript" &&
            move.artifact !== undefined &&
            (move.artifact.classification === "imported" ||
              move.artifact.classification === "repair-original") &&
            move.artifact.reason === "verified-import-original" &&
            move.artifact.disposal.state === "retained",
        ),
      );
      const move = completed.find((candidate) => candidate?.artifact);
      if (
        !move?.artifact ||
        !targetRefs.some(
          (ref, index) =>
            completed[index] && (ref.run.manifest.failedAt || ref.run.manifest.failureReports),
        ) ||
        targetRefs.some((ref, index) => {
          const recorded = completed[index] ?? ref.move;
          return (
            ref.target.validationBeforeArchive !== "passed" ||
            ref.target.issues.some((issue) => !isSessionSqliteMigrationWarning(issue)) ||
            !recorded.artifact ||
            recorded.kind !== "transcript" ||
            recorded.artifact.reason !== "verified-import-original" ||
            (recorded.artifact.classification !== "imported" &&
              recorded.artifact.classification !== "repair-original") ||
            recorded.artifact.disposal.state !== "retained" ||
            !sameMigrationArtifact(recorded.artifact.identity, move.artifact!.identity) ||
            (!completed[index] &&
              ref.run.manifest.completedAt !== undefined &&
              !ref.run.manifest.failedAt &&
              !ref.run.manifest.failureReports)
          );
        })
      ) {
        continue;
      }
      try {
        if (
          statMigrationPath(move.sourcePath) !== undefined ||
          !sameMigrationArtifact(
            readMigrationArtifactIdentity(move.archivePath),
            move.artifact.identity,
          )
        ) {
          continue;
        }
        evidence.push({ move, sourceIdentity: move.artifact.identity, target: firstRef.target });
      } catch {
        // Changed or inaccessible archives cannot become replay authority.
      }
    }
  }
  return evidence;
}

// Only a completed move can distinguish a restored input from a first import. The archive or
// restore receipt proves provenance; matching live bytes admit replay under the current owner.
function collectCompletedMoveAuthorities(
  groups: Iterable<readonly RecoveryArtifactReference[]>,
  kind: SessionSqliteMigrationMove["kind"],
): CompletedMoveEvidence[] {
  const evidence: CompletedMoveEvidence[] = [];
  for (const refs of groups) {
    const firstRef = refs[0];
    if (
      !firstRef ||
      refs.some(
        (ref) =>
          !ref.trusted ||
          ref.move.kind !== kind ||
          ref.move.sourcePath !== firstRef.move.sourcePath ||
          ref.target.validationBeforeArchive !== "passed" ||
          ref.target.issues.some((issue) => !isSessionSqliteMigrationWarning(issue)),
      )
    ) {
      continue;
    }
    const completed = refs.map((ref) => {
      if (
        !ref.run.manifest.completedAt ||
        ref.run.manifest.failedAt ||
        ref.run.manifest.failureReports ||
        ref.target.validationBeforeArchive !== "passed" ||
        ref.target.issues.some((issue) => !isSessionSqliteMigrationWarning(issue)) ||
        (kind === "legacy-store" && ref.move.sourcePath !== ref.target.storePath)
      ) {
        return undefined;
      }
      return ref.target.completedMoves.find(
        (move) =>
          migrationMoveKey(move) === migrationMoveKey(ref.move) &&
          move.kind === kind &&
          move.artifact !== undefined &&
          (kind === "legacy-store"
            ? move.artifact.classification === "imported"
            : move.artifact.classification === "imported" ||
              move.artifact.classification === "repair-original") &&
          move.artifact.reason ===
            (kind === "legacy-store" ? "verified-index-import" : "verified-import-original") &&
          move.artifact.disposal.state === "retained",
      );
    });
    const completedRefs = completed.flatMap((move, index) =>
      move ? [{ move, ref: refs[index]! }] : [],
    );
    const first = completedRefs[0]?.move;
    if (
      !first?.artifact ||
      completedRefs.some(
        ({ move }) =>
          !move.artifact ||
          !sameMigrationArtifact(move.artifact.identity, first.artifact!.identity),
      ) ||
      refs.some(
        (ref, index) =>
          !completed[index] &&
          (kind !== "transcript" ||
            !ref.move.artifact ||
            ref.move.artifact.reason !== "verified-import-original" ||
            ref.move.artifact.disposal.state !== "retained" ||
            (ref.move.artifact.classification !== "imported" &&
              ref.move.artifact.classification !== "repair-original") ||
            !sameMigrationArtifact(ref.move.artifact.identity, first.artifact!.identity)),
      )
    ) {
      continue;
    }
    try {
      if (!fs.existsSync(first.sourcePath)) {
        continue;
      }
      const sourceIdentity = readMigrationArtifactIdentity(first.sourcePath);
      if (!sameMigrationArtifactContent(sourceIdentity, first.artifact.identity)) {
        continue;
      }
      const consumed = completedRefs[0]!.ref.consumedByRestore;
      if (completedRefs.some(({ ref }) => ref.consumedByRestore !== consumed)) {
        continue;
      }
      if (consumed) {
        if (fs.existsSync(first.archivePath)) {
          continue;
        }
      } else if (
        !fs.existsSync(first.archivePath) ||
        !sameMigrationArtifact(
          readMigrationArtifactIdentity(first.archivePath),
          first.artifact.identity,
        )
      ) {
        continue;
      }
      for (const { move, ref } of completedRefs) {
        evidence.push({
          move,
          sourceIdentity,
          target: ref.target,
        });
      }
    } catch {
      // Inaccessible receipt evidence grants neither replay nor conflict authority.
    }
  }
  return evidence;
}

export function collectCompletedStoreReplays(
  groups: Iterable<readonly RecoveryArtifactReference[]>,
): CompletedLegacyStoreReplay[] {
  const candidates = [...groups];
  const completedStores = collectCompletedMoveAuthorities(candidates, "legacy-store");
  const completedTranscripts = collectCompletedMoveAuthorities(candidates, "transcript");
  const verifyOnlyTranscriptArchives = collectVerifyOnlyTranscriptArchives(candidates);
  return completedStores.map<CompletedLegacyStoreReplay>((store) => {
    const dependencies = new Set(store.move.artifact!.dependencies.map(canonicalMigrationFilePath));
    return {
      move: store.move,
      sourceIdentity: store.sourceIdentity,
      target: {
        agentId: store.target.agentId,
        sqlitePath: store.target.sqlitePath,
        storePath: store.target.storePath,
      },
      // Dependencies acquire authority only from the same producing manifest target.
      verifiedTranscriptIdentities: new Map(
        completedTranscripts.flatMap((transcript) =>
          dependencies.has(canonicalMigrationFilePath(transcript.move.sourcePath)) &&
          transcript.target === store.target
            ? [
                [
                  canonicalMigrationFilePath(transcript.move.sourcePath),
                  transcript.sourceIdentity,
                ] as const,
              ]
            : [],
        ),
      ),
      verifyOnlyTranscriptArchives: new Map(
        verifyOnlyTranscriptArchives.flatMap((transcript) =>
          dependencies.has(canonicalMigrationFilePath(transcript.move.sourcePath)) &&
          sameMigrationTarget(transcript.target, store.target)
            ? [[canonicalMigrationFilePath(transcript.move.sourcePath), transcript.move] as const]
            : [],
        ),
      ),
    };
  });
}
