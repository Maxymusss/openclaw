import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export const SUBAGENT_KILL_TASK_ERROR = "Subagent run killed.";
export type SubagentTerminalState = {
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string | null;
  terminalOutcome?: "succeeded" | "blocked";
};
export type SubagentKillTargetState =
  | { state: "finalizing" }
  | { state: "terminal"; task: SubagentTerminalState };
export type SubagentAdminKillResult =
  | { found: false; killed: false }
  | {
      found: true;
      killed: boolean;
      runId: string;
      sessionKey: string;
      cascadeKilled: number;
      cascadeLabels?: string[];
      targetState?: SubagentKillTargetState;
      error?: string;
    };
export type SubagentAdminKillParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  expectedRunId?: string;
  expectedTaskRunId?: string;
  expectedGeneration?: number;
  expectedOwnerKey?: string;
  onResult?: (result: SubagentAdminKillResult) => undefined;
};
