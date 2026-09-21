import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import type {
  AcpSessionRuntimeOptions,
  SessionAcpIdentity,
  SessionAcpMeta,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type AcpSessionEntryBinding,
  type AcpSessionRow,
  resolveReadableAcpSessionRow,
  selectAcpSessionRowForStoreEntry,
} from "./session-meta-keys.js";

export function rowToAcpSessionMeta(row: AcpSessionRow): SessionAcpMeta {
  // SAFETY: These JSON columns are written from the typed ACP metadata by its storage owner.
  const identity = safeParseJsonRecord(row.identity_json ?? "") as SessionAcpIdentity | undefined;
  // SAFETY: Runtime options share the same typed persisted metadata contract.
  const runtimeOptions = safeParseJsonRecord(row.runtime_options_json ?? "") as
    | AcpSessionRuntimeOptions
    | undefined;
  return {
    backend: row.backend,
    agent: row.agent,
    runtimeSessionName: row.runtime_session_name,
    ...(identity ? { identity } : {}),
    mode: row.mode === "oneshot" ? "oneshot" : "persistent",
    ...(runtimeOptions ? { runtimeOptions } : {}),
    ...(row.cwd != null ? { cwd: row.cwd } : {}),
    state: row.state === "running" || row.state === "error" ? row.state : "idle",
    lastActivityAt: row.last_activity_at,
    ...(row.last_error != null ? { lastError: row.last_error } : {}),
  };
}

export type AcpSessionMetaEntryRead = {
  sessionKey: string;
  agentId?: string;
  entry: AcpSessionEntryBinding | undefined;
};

/** Canonical entry binding and legacy-key selection, shared by native and worker readers. */
export function readAcpSessionMetaForEntryInDatabase(
  db: DatabaseSync,
  params: AcpSessionMetaEntryRead & { cfg?: OpenClawConfig },
): SessionAcpMeta | undefined {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const row = resolveReadableAcpSessionRow({
    row: selectAcpSessionRowForStoreEntry(db, sessionKey, params.agentId, params.cfg, params.entry),
    entry: params.entry,
  });
  return row ? rowToAcpSessionMeta(row) : undefined;
}
