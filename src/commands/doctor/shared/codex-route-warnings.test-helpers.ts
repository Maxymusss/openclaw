import { expect } from "vitest";
import type { maybeRepairCodexRoutes } from "./codex-route-warnings.js";

type CodexRouteRepairResult = ReturnType<typeof maybeRepairCodexRoutes>;

const CODEX_PLUGIN_REPAIR_CHANGES = [
  "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
  "Added codex to plugins.allow because configured agent routes use Codex runtime.",
];

export const CODEX_COMPACTION_REPAIR_CHANGES = [
  "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
  "Removed agents.defaults.compaction.provider; Codex runtime uses native server-side compaction.",
];

export function legacyRouteWarning(...routes: string[]): string {
  return [
    "- Legacy `codex/*` and `openai-codex/*` model refs should be rewritten to `openai/*`.",
    ...routes,
    "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
  ].join("\n");
}

export function disabledCodexPluginWarning(...routes: string[]): string {
  return [
    "- Codex runtime is selected, but the Codex plugin is disabled.",
    ...routes,
    "- Enable plugins.entries.codex and plugin loading, and remove `codex` from plugins.deny; or set the affected OpenAI models to an OpenClaw runtime policy.",
  ].join("\n");
}

export function codexCompactionWarning(...details: string[]): string {
  return [
    "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
    ...details,
  ].join("\n");
}

export function losslessCompactionWarning(...routes: string[]): string {
  return [
    "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
    ...routes,
    "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
  ].join("\n");
}

export function expectCodexPluginEnabled(result: CodexRouteRepairResult) {
  expect(result.warnings).toStrictEqual([]);
  expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
  expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
}

export function expectCodexPluginDisabled(result: CodexRouteRepairResult) {
  expect(result.warnings).toStrictEqual([]);
  expect(result.changes).toStrictEqual([]);
  expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
}
