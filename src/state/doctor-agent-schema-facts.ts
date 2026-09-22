import { lstatSync, realpathSync, statSync } from "node:fs";
import { resolveStateDir } from "../config/paths.js";
import {
  sameFileMutationFingerprint,
  type FileMutationFingerprint,
} from "../infra/file-descriptor.js";
import { readSourceJournalMode } from "../infra/sqlite-readonly-location.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import type { AgentSchemaInspection } from "./openclaw-agent-schema-inspection.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type DoctorHeaderInput = {
  pathname: string;
  agentId: string;
  supportedVersion: number;
  env: NodeJS.ProcessEnv;
};
type Witness = { key: string; main: FileMutationFingerprint };
type Header = Readonly<{
  version: number;
  writerAppVersion?: string;
  agentSchemaMeta: Readonly<{ role: "agent"; agentId: string; schemaVersion: number }>;
}>;

function capture(input: DoctorHeaderInput): Witness | undefined {
  try {
    const pathname = realpathSync.native(input.pathname);
    const root = realpathSync.native(resolveStateDir(input.env));
    const rootStat = statSync(root, { bigint: true });
    const main = statSync(pathname, { bigint: true });
    if (
      !rootStat.isDirectory() ||
      !main.isFile() ||
      readSourceJournalMode(pathname) !== "wal" ||
      ["-wal", "-shm", "-journal"].some(
        (suffix) => lstatSync(pathname + suffix, { throwIfNoEntry: false }) !== undefined,
      )
    ) {
      return undefined;
    }
    return {
      key: JSON.stringify([
        pathname,
        input.agentId,
        input.supportedVersion,
        resolveOpenClawStateSqlitePath(input.env),
        root,
        String(rootStat.dev),
        String(rootStat.ino),
        String(rootStat.birthtimeNs),
      ]),
      main,
    };
  } catch {
    return undefined;
  }
}

/** One Doctor invocation hands complete headers to its lease-held admission, never readiness. */
export class DoctorAgentSchemaFacts {
  private phase: "collecting" | "published" | "refreshing" | "discarded" = "collecting";
  private readonly headers = new Map<string, { witness: Witness; header: Header }>();

  constructor(private readonly signal?: AbortSignal) {}

  private assertActive(): void {
    if (this.signal?.aborted) {
      this.discard();
      this.signal.throwIfAborted();
    }
  }

  /** Capture before inspection; the caller must settle native close and snapshot cleanup first. */
  prepare(input: DoctorHeaderInput): ((inspection: AgentSchemaInspection) => void) | undefined {
    this.assertActive();
    if (this.phase !== "collecting" || input.supportedVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
      return undefined;
    }
    const before = capture(input);
    if (!before) {
      return undefined;
    }
    return (inspection) => {
      this.assertActive();
      const owner = inspection.agentSchemaMeta;
      if (
        this.phase !== "collecting" ||
        inspection.failure ||
        inspection.reason ||
        inspection.version !== input.supportedVersion ||
        owner?.role !== "agent" ||
        owner.agentId !== input.agentId ||
        owner.schemaVersion !== input.supportedVersion
      ) {
        return;
      }
      const after = capture(input);
      if (after?.key !== before.key || !sameFileMutationFingerprint(before.main, after.main)) {
        return;
      }
      this.headers.set(before.key, {
        witness: before,
        header: Object.freeze({
          version: inspection.version,
          ...(inspection.writerAppVersion !== undefined
            ? { writerAppVersion: inspection.writerAppVersion }
            : {}),
          agentSchemaMeta: Object.freeze({
            role: "agent",
            agentId: owner.agentId,
            schemaVersion: owner.schemaVersion,
          }),
        }),
      });
    };
  }

  /** Whole startup admission, including its config/plugin guards, must have succeeded. */
  publish(): void {
    this.assertActive();
    if (this.phase === "collecting") {
      this.phase = "published";
    }
  }

  beginRefresh(): void {
    this.assertActive();
    if (this.phase === "published") {
      this.phase = "refreshing";
    } else {
      this.discard();
    }
  }

  read(input: DoctorHeaderInput): Header | undefined {
    this.assertActive();
    if (this.phase !== "refreshing") {
      return undefined;
    }
    const current = capture(input);
    const stored = current && this.headers.get(current.key);
    return current && stored && sameFileMutationFingerprint(stored.witness.main, current.main)
      ? stored.header
      : undefined;
  }

  discard(): void {
    this.phase = "discarded";
    this.headers.clear();
  }
}
