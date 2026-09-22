/** Offline Doctor target discovery and legacy-source admission. */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
  type SessionStoreTarget as ResolvedSessionStoreTarget,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  collectHistoricalArchiveSources,
  HistoricalArchiveSources,
} from "./doctor-session-sqlite-discovery.js";
import {
  canonicalMigrationFilePath,
  type SessionSqliteMigrationTargetInput,
} from "./doctor-session-sqlite-migration-run.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import type { DoctorSessionSqliteMode } from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

export function resolveDoctorSessionSqliteTargets(params: {
  allAgents?: boolean;
  agent?: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  store?: string;
}): SessionStoreTarget[] {
  if (params.store) {
    return resolveSessionStoreTargets(params.cfg, { store: params.store }, { env: params.env });
  }
  const discoversHistory =
    params.mode === "dry-run" || params.mode === "import" || params.mode === "validate";
  if (
    params.mode === "restore" ||
    params.mode === "recover" ||
    (discoversHistory && params.agent)
  ) {
    const candidates = resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, {
      env: params.env,
    });
    if (!params.agent) {
      return candidates;
    }
    const requestedAgentId = normalizeAgentId(params.agent);
    return candidates.filter((target) => normalizeAgentId(target.agentId) === requestedAgentId);
  }
  if (params.agent) {
    return resolveAgentSessionStoreTargetsSync(params.cfg, params.agent, { env: params.env });
  }
  if (params.allAgents) {
    // Discovery must admit validated directories even before either registry exists.
    const targets = discoversHistory
      ? resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, { env: params.env })
      : resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env });
    if (!discoversHistory) {
      return targets;
    }
    const legacyStorePath = path.join(resolveStateDir(params.env), "sessions", "sessions.json");
    if (!fs.existsSync(legacyStorePath)) {
      return targets;
    }
    const legacyTargets = resolveSessionStoreTargets(
      params.cfg,
      { allAgents: true },
      { env: params.env },
    ).map((target) => ({
      agentId: target.agentId,
      sqlitePath: resolveTargetSqlitePath(target),
      storePath: legacyStorePath,
    }));
    return [...legacyTargets, ...targets];
  }
  return resolveSessionStoreTargets(params.cfg, {}, { env: params.env });
}

export function filterLegacySessionStoreTargets(
  targets: SessionStoreTarget[],
  mode: DoctorSessionSqliteMode,
  historicalArchives: HistoricalArchiveSources,
  settledStores: ReadonlySet<string>,
): SessionStoreTarget[] {
  if (mode === "inspect" || mode === "compact" || mode === "restore" || mode === "recover") {
    return targets;
  }
  return targets.filter(
    (target) =>
      !target.storePath.endsWith(".sqlite") &&
      (settledStores.has(target.storePath) ||
        fs.existsSync(target.storePath) ||
        (historicalArchives.get(canonicalMigrationFilePath(target.storePath))?.transcripts.length ??
          0) > 0 ||
        (fs.existsSync(path.dirname(target.storePath)) &&
          fs.readdirSync(path.dirname(target.storePath)).some(isPrimarySessionTranscriptFileName))),
  );
}

export function createMigrationTargetInput(
  target: SessionStoreTarget,
): SessionSqliteMigrationTargetInput {
  return {
    agentId: target.agentId,
    sqlitePath: canonicalMigrationFilePath(resolveTargetSqlitePath(target)),
    storePath: canonicalMigrationFilePath(target.storePath),
  };
}

export function selectDoctorSessionSqliteOperationTargets(
  candidates: SessionStoreTarget[],
  mode: DoctorSessionSqliteMode,
  history?: Pick<ReturnType<typeof collectHistoricalArchiveSources>, "sources" | "claims">,
): SessionStoreTarget[] {
  const legacy = filterLegacySessionStoreTargets(
    candidates,
    mode,
    history?.sources ?? new Map(),
    new Set(),
  );
  if (mode !== "import" || !history?.claims.length) {
    return legacy;
  }
  const eligible = new Set(legacy);
  const claimedTargets = history.claims.map(([refs]) => refs![0]!.target);
  // Acknowledged archives can still need duplicate settlement after their import
  // sources disappear. Admit their exact destinations before any disposal starts.
  return candidates.filter((target) => {
    if (eligible.has(target)) {
      return true;
    }
    const storePath = canonicalMigrationFilePath(target.storePath);
    const matchingClaims = claimedTargets.filter(
      (claim) => claim.agentId === target.agentId && claim.storePath === storePath,
    );
    if (matchingClaims.length === 0) {
      return false;
    }
    const input = createMigrationTargetInput(target);
    return matchingClaims.some((claim) => claim.sqlitePath === input.sqlitePath);
  });
}
