/** The prompt-only CLI owner keeps admission and cleanup together. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempWorkspace } from "../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { normalizeCliModel } from "./cli-runner/helpers.js";
import { hasCliSideEffectEvidence, IsolatedCompletionError } from "./isolated-completion-output.js";
import type { RunIsolatedCompletionParams } from "./isolated-completion.types.js";
import type { UsageLike } from "./usage.js";

export async function runCliIsolatedCompletion(params: {
  request: RunIsolatedCompletionParams & { config: OpenClawConfig };
  provider: string;
  modelProvider: string;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
}): Promise<{ model: string; text: string; usage?: UsageLike }> {
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-isolated-completion-" },
    async ({ dir }) => {
      const { runCliAgent } = await import("./cli-runner.runtime.js");
      params.request.assertCurrent?.();
      const sessionId = `isolated-completion-${randomUUID()}`;
      const config = params.request.config;
      const preparedRunAdmission = prepareSystemAgentRunAdmission(
        config,
        sessionId,
        params.agentId,
        "isolated-completion",
        params.request.assertCurrent,
        params.request.operatorAuthority,
      );
      try {
        params.request.assertCurrent?.();
        const result = await runCliAgent({
          preparedRunAdmission,
          sessionId,
          sessionFile: path.join(dir, "session.json"),
          workspaceDir: params.workspaceDir,
          cwd: dir,
          agentDir: params.agentDir,
          agentId: params.agentId,
          config,
          prompt: params.request.prompt,
          extraSystemPrompt: params.request.systemPrompt,
          timeoutMs: params.request.timeoutMs,
          runId: sessionId,
          provider: params.provider,
          modelProvider: params.modelProvider,
          requesterModel: { provider: params.modelProvider, model: params.request.model },
          model: params.request.model,
          // The CLI runner treats a supplied profile as exact; it auto-selects only
          // when this field is absent. This path has no embedded-run fallback loop.
          authProfileId: params.request.authProfileId,
          thinkLevel: params.request.thinkLevel,
          streamParams: params.request.streamParams,
          abortSignal: params.request.abortSignal,
          assertCurrent: params.request.assertCurrent,
          executionMode: "side-question",
          cliToolAvailability: { native: [], openClaw: [] },
          disableTools: true,
          disableCliLiveSession: true,
          cleanupCliLiveSessionOnRunEnd: true,
          cleanupBundleMcpOnRunEnd: true,
          requireExplicitMessageTarget: true,
          isolatedCompletion: true,
          outputTextPolicy: params.request.outputTextPolicy,
        });
        if (hasCliSideEffectEvidence(result)) {
          throw new IsolatedCompletionError(
            "output-rejected",
            "Isolated CLI completion returned side-effect evidence; result rejected.",
          );
        }
        const payloads = result.payloads ?? [];
        if (
          payloads.some(
            (payload) =>
              payload.isError ||
              payload.mediaUrl ||
              payload.mediaUrls?.length ||
              payload.audioAsVoice ||
              payload.channelData,
          )
        ) {
          throw new IsolatedCompletionError(
            "output-rejected",
            "Isolated CLI completion returned non-text output; result rejected.",
          );
        }
        const text = payloads
          .filter((payload) => !payload.isReasoning && typeof payload.text === "string")
          .map((payload) => payload.text ?? "")
          .join("\n")
          .trim();
        const backend = resolveCliBackendConfig(params.provider, params.request.config, {
          agentId: params.agentId,
        });
        if (!backend) {
          throw new IsolatedCompletionError(
            "runtime-unavailable",
            `CLI backend ${params.provider} became unavailable after execution.`,
          );
        }
        const usage = result.meta?.agentMeta?.usage;
        return {
          text,
          model: normalizeCliModel(params.request.model, backend.config),
          ...(usage ? { usage } : {}),
        };
      } finally {
        preparedRunAdmission.close();
      }
    },
  );
}
