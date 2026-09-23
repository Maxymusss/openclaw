import type { SessionProviderReviewComparison } from "../config/sessions/provider-review.types.js";
import type {
  SessionEntryReplacementCommit,
  SessionEntryReplacementCommitted,
} from "../config/sessions/session-accessor.sqlite-replacement-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDatabaseRegistryChange } from "./openclaw-agent-db-registry-listing.js";
import type { AgentDatabaseDomainOperations } from "./openclaw-agent-execution-domain.js";

/** Recorded by the native owner; a descriptor never grants access to that owner. */
export type AgentDatabaseExecutionIdentity = {
  kind: "file";
  physicalIdentity: string;
  incarnation: string;
  nativeLocation: string;
};

export type AgentDatabaseExecutionFileIdentity = Pick<
  AgentDatabaseExecutionIdentity,
  "kind" | "physicalIdentity" | "nativeLocation"
>;

export type AgentDatabaseExecutionOpen = {
  leaseId: string;
  agentId: string;
  databasePath: string;
  stateDatabasePath: string;
  environment: { OPENCLAW_STATE_DIR: string; OPENCLAW_SUPERVISOR_MODE?: "external" };
  expectedIdentity?: AgentDatabaseExecutionFileIdentity;
  /** Captured before a creating request yields; absence is an identity too. */
  creatingIdentity?: DatabasePathIdentity;
};

export type AgentDatabaseOperations = AgentDatabaseDomainOperations & {
  "database.prepareWrite": { input: undefined; output: void };
  "session.entry.read": { input: { sessionKey: string }; output: SessionEntry | undefined };
  "session.entries.replace": {
    input: SessionEntryReplacementCommit;
    output: SessionEntryReplacementCommitted;
  };
  "session.providerReview.compare": {
    input: SessionProviderReviewComparison;
    output: SessionEntry;
  };
};

/** A request owner composes its retained admission with the native owner's validation. */
export type AgentDatabaseRequestExecutionSource = {
  assertCurrent(): void;
  onRegistryChange?: (change: AgentDatabaseRegistryChange) => void;
  createAdmission(params: {
    nativeLocations: readonly string[];
    authorize(request: SqliteWorkerAdmissionRequest): void;
    assertCurrent(): void;
  }): SqliteWorkerAdmissionFactory;
};
