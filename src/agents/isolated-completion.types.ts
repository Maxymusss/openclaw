import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import type { AgentHarnessIsolatedCompletionParamsV2 } from "./harness/types.js";
import type { UsageLike } from "./usage.js";

export type RunIsolatedCompletionParams = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  config?: OpenClawConfig;
  provider: string;
  model: string;
  /** Explicit credential owner. CLI and harness paths must not replace it with another profile. */
  authProfileId?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  /** Concrete owner already resolved by the caller, when available. */
  agentHarnessRuntimeOverride?: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  /** Revalidate the caller's authority before credential handoff and dispatch. */
  assertCurrent?: () => void;
  thinkLevel?: ThinkLevel;
  outputTextPolicy?: AgentHarnessIsolatedCompletionParamsV2["outputTextPolicy"];
  streamParams?: AgentHarnessIsolatedCompletionParamsV2["streamParams"];
};

export type IsolatedCompletionResult = {
  text: string;
  provider: string;
  model: string;
  owner: { kind: "cli" | "harness"; id: string };
  /** CLI runtimes may not report token usage; absence must not be projected as zero. */
  usage?: UsageLike;
};
