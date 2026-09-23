import fs from "node:fs/promises";
import path from "node:path";
import { buildCodexHarnessAppServerArgs } from "../../src/gateway/gateway-codex-harness.live-helpers.js";
import type { AgentEventPayload } from "../../src/infra/agent-events.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../../src/secrets/provider-env-vars.js";
// Native live fixture setup and capture shared with its offline boundary regressions.
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";

export function createCodexHarnessLiveInstance(
  token: string,
  authMode: "codex-auth" | "api-key" = "codex-auth",
) {
  return createOpenClawTestInstance({
    name: "live-codex-harness",
    // test-env already staged native Codex auth/config in the caller home.
    state: { layout: "state-only" },
    gatewayToken: token,
    env: {
      ...Object.fromEntries(
        listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
      ),
      OPENCLAW_AGENT_RUNTIME: "codex",
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1",
      // Admission and completion must share the normal, built Gateway lifecycle.
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
      OPENAI_API_KEY: authMode === "api-key" ? process.env.OPENAI_API_KEY : undefined,
      OPENAI_BASE_URL:
        authMode === "api-key" && process.env.OPENAI_BASE_URL?.trim()
          ? process.env.OPENAI_BASE_URL
          : undefined,
    },
  });
}

// Full-context assertions consume native usage separately from lifecycle/compaction.
export const CODEX_HARNESS_CONTEXT_EVENT_PREFIXES = [
  "codex_app_server.",
  "compaction",
  "usage",
] as const;

export function createCodexHarnessEventCapture(params: {
  eventPrefix?: string;
  eventPrefixes?: readonly string[];
  includeAllSessions?: boolean;
  sessionKey: string;
}) {
  const events: CapturedAgentEvent[] = [];
  const eventPrefixes = params.eventPrefixes ?? [params.eventPrefix ?? "codex_app_server.guardian"];
  let requestStartedAt = 0;
  let firstAssistantMs: number | undefined;
  return {
    events,
    start(startedAt: number) {
      requestStartedAt = startedAt;
    },
    get firstAssistantMs() {
      return firstAssistantMs;
    },
    onAgentEvent(this: void, event: AgentEventPayload) {
      if (
        !params.includeAllSessions &&
        event.sessionKey &&
        event.sessionKey !== params.sessionKey
      ) {
        return;
      }
      if (event.stream === "assistant" && requestStartedAt > 0 && firstAssistantMs === undefined) {
        firstAssistantMs = Math.max(0, event.ts - requestStartedAt);
      }
      if (!eventPrefixes.some((prefix) => event.stream.startsWith(prefix))) {
        return;
      }
      events.push({
        runId: event.runId,
        stream: event.stream,
        sessionKey: event.sessionKey,
        data: event.data,
        ts: event.ts,
      });
    },
  };
}

export type CapturedAgentEvent = {
  runId?: string;
  stream: string;
  data?: Record<string, unknown>;
  sessionKey?: string;
  ts?: number;
};

export type CodexNativeUsageSnapshot = {
  activeContextTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  inputTokens?: number;
  modelContextWindow: number;
  outputTokens?: number;
  promptTokens: number;
};

export function readCodexNativeUsageSnapshots(
  events: readonly CapturedAgentEvent[],
): CodexNativeUsageSnapshot[] {
  return events.flatMap((event) => {
    if (event.stream !== "usage") {
      return [];
    }
    const activeContextTokens = event.data?.activeContextTokens;
    const modelContextWindow = event.data?.modelContextWindow;
    const promptTokens = event.data?.promptTokens;
    if (
      typeof activeContextTokens !== "number" ||
      typeof modelContextWindow !== "number" ||
      typeof promptTokens !== "number"
    ) {
      return [];
    }
    const optionalNumber = (key: string): number | undefined => {
      const value = event.data?.[key];
      return typeof value === "number" ? value : undefined;
    };
    const cachedInputTokens = optionalNumber("cachedInputTokens");
    const cacheWriteInputTokens = optionalNumber("cacheWriteInputTokens");
    const inputTokens = optionalNumber("inputTokens");
    const outputTokens = optionalNumber("outputTokens");
    return [
      {
        activeContextTokens,
        modelContextWindow,
        promptTokens,
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
    ];
  });
}

export type CodexCompactionStressMode =
  | { kind: "off" }
  | { kind: "reduced" }
  | { kind: "full"; modelCatalogPath: string };

export const CODEX_REDUCED_CONTEXT_AUTO_COMPACT_LIMIT = 4_000;

export async function createCodexHarnessWorkspace(workspace: string): Promise<void> {
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "AGENTS.md"),
    [
      "# AGENTS.md",
      "",
      "Follow exact reply instructions from the user.",
      "Do not add commentary when asked for an exact response.",
    ].join("\n"),
  );
}

export function parseCodexHarnessModelKey(modelKey: string): { provider: string; modelId: string } {
  const [provider, ...modelParts] = modelKey.split("/");
  const modelId = modelParts.join("/");
  if (!provider?.trim() || !modelId.trim()) {
    throw new Error(`invalid model key: ${modelKey}`);
  }
  return { provider: provider.trim(), modelId: modelId.trim() };
}

export function buildCodexHarnessDenseContext(params: { marker: string; chars: number }): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < params.chars; index += 1) {
    const line =
      `${params.marker}|Context stress record ${index}: the copper lighthouse tracks violet weather ` +
      `while patient engineers preserve durable state across each compacted conversation.\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join("").slice(0, params.chars);
}

export function buildCodexCompactionAppServerArgs(
  mode: CodexCompactionStressMode,
): string[] | undefined {
  const overrides =
    mode.kind === "full"
      ? [
          `model_catalog_json=${JSON.stringify(mode.modelCatalogPath)}`,
          "model_context_window=922000",
          "model_auto_compact_token_limit=700000",
          "model_auto_compact_token_limit_scope=total",
          "tool_output_token_limit=200000",
        ]
      : mode.kind === "reduced"
        ? [
            "model_auto_compact_token_limit_scope=body_after_prefix",
            // Raw nested CodeMode output is not necessarily emitted to model context.
            `model_auto_compact_token_limit=${CODEX_REDUCED_CONTEXT_AUTO_COMPACT_LIMIT}`,
            "tool_output_token_limit=10000",
          ]
        : undefined;
  return overrides ? buildCodexHarnessAppServerArgs(overrides) : undefined;
}
