import type { OpenClawRegisteredAgentDatabase } from "./openclaw-agent-db-contract.js";

type RetainedAgentDeletion = { agentId: string; agentDir: string; databasePaths: string[] };

export type AgentDeletionJournalDisposition = readonly RetainedAgentDeletion[] | "unavailable";

export type AgentDatabaseDeletionSnapshot = {
  retainedDeletions: AgentDeletionJournalDisposition;
  registeredAgentDatabases: OpenClawRegisteredAgentDatabase[];
};

export type AgentDeletionJournalStatus = "absent" | "pending" | "complete";
