import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AgentCompactionMode } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import type { resolveCliBackendConfig as resolveCliBackendConfigImpl } from "../cli-backends.js";
import type { clearCliSessionInStore as clearCliSessionInStoreImpl } from "../cli-session-store.js";
import type { buildEmbeddedCompactionRuntimeContext } from "../embedded-agent-runner/compaction-runtime-context.js";
import type { AcceptedCompactionSuccessor } from "../embedded-agent-runner/compaction-successor.js";
import type { runContextEngineMaintenance as runContextEngineMaintenanceImpl } from "../embedded-agent-runner/context-engine-maintenance.js";
import type { shouldPreemptivelyCompactBeforePrompt as shouldPreemptivelyCompactBeforePromptImpl } from "../embedded-agent-runner/run/preemptive-compaction.js";
import type { resolveLiveToolResultMaxChars as resolveLiveToolResultMaxCharsImpl } from "../embedded-agent-runner/tool-result-truncation.js";
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";
import type { maybeCompactAgentHarnessSession as maybeCompactAgentHarnessSessionImpl } from "../harness/compaction.js";
import type { ensureSelectedAgentHarnessPlugin as ensureSelectedAgentHarnessPluginImpl } from "../harness/runtime-plugin.js";
import type { acquireAgentRunPreparedModelRuntime } from "../prepared-model-runtime.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { recordCliCompactionInStore as recordCliCompactionInStoreImpl } from "./session-store.js";

export type SessionManagerLike = ReturnType<typeof SessionManager.open>;
export type SettingsManagerLike = {
  getCompactionReserveTokens: () => number;
  getCompactionKeepRecentTokens: () => number;
  applyOverrides: (overrides: {
    compaction: {
      reserveTokens?: number;
      keepRecentTokens?: number;
    };
  }) => void;
  setCompactionEnabled?: (enabled: boolean) => void;
};
export type CliCompactionDeps = {
  openSessionManager: (target: SessionTranscriptRuntimeTarget) => SessionManagerLike;
  ensureContextEnginesInitialized: () => void;
  resolveContextEngine: (cfg: OpenClawConfig) => Promise<ContextEngine>;
  createPreparedEmbeddedAgentSettingsManager: (params: {
    cwd: string;
    agentDir: string;
    cfg?: OpenClawConfig;
    contextTokenBudget?: number;
  }) => SettingsManagerLike | Promise<SettingsManagerLike>;
  applyAgentAutoCompactionGuard: (params: {
    settingsManager: SettingsManagerLike;
    contextEngineInfo?: ContextEngine["info"];
    compactionMode?: AgentCompactionMode;
  }) => unknown;
  shouldPreemptivelyCompactBeforePrompt: typeof shouldPreemptivelyCompactBeforePromptImpl;
  resolveLiveToolResultMaxChars: typeof resolveLiveToolResultMaxCharsImpl;
  runContextEngineMaintenance: typeof runContextEngineMaintenanceImpl;
  acquirePreparedModelRuntime: typeof acquireAgentRunPreparedModelRuntime;
  ensureSelectedAgentHarnessPlugin: typeof ensureSelectedAgentHarnessPluginImpl;
  maybeCompactAgentHarnessSession: typeof maybeCompactAgentHarnessSessionImpl;
  clearCliSessionInStore: typeof clearCliSessionInStoreImpl;
  resolveCliBackendConfig: typeof resolveCliBackendConfigImpl;
  recordCliCompactionInStore: typeof recordCliCompactionInStoreImpl;
};

export type NativeHarnessCliCompactionOutcome = {
  compacted: boolean;
  result?: EmbeddedAgentCompactResult;
  fallbackToContextEngine?: boolean;
  clearCliSessionBinding?: boolean;
  failureReason?: string;
};
export type CliTranscriptCompactionOutcome = {
  compacted: boolean;
  failureReason?: string;
  accepted?: AcceptedCompactionSuccessor;
  tokensAfter?: number;
};
export type CliCompactionContext = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  cfg: OpenClawConfig;
  sessionKey: string;
  workspaceDir: string;
  cwd?: string;
  agentDir: string;
  provider: string;
  model: string;
  skillsSnapshot?: SkillSnapshot;
  messageChannel?: string;
  agentAccountId?: string;
  senderIsOwner?: boolean;
  thinkLevel?: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  extraSystemPrompt?: string;
};

export type CliCompactionRuntimeContextParams = CliCompactionContext & {
  authProfileId?: string;
  harnessRuntime?: string;
  modelSelectionLocked?: boolean;
  currentTokenCount: number;
  contextTokenBudget: number;
  trigger: string;
};
