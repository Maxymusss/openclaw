// Coverage for prompt helper decisions used before embedded attempts.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import type { NormalizedUsage } from "../../usage.js";
import { buildContextEnginePromptCacheInfo } from "./attempt-context-engine-helpers.js";

const hostHookStateMocks = vi.hoisted(() => ({
  drainPluginNextTurnInjectionContext: vi.fn(),
}));

vi.mock("../context-engine-capabilities.js", () => ({
  resolveContextEngineCapabilities: async () => ({ llm: undefined }),
}));

vi.mock("../../../plugins/host-hook-state.js", () => hostHookStateMocks);

import {
  buildAfterTurnRuntimeContext,
  buildAfterTurnRuntimeContextFromUsage,
  forgetPromptBuildDrainCacheForRun,
  mergeOrphanedTrailingUserPrompt,
  resolvePromptBuildHookResult,
} from "./attempt-prompt-helpers.js";
import { resolvePromptSubmissionSkipReason } from "./attempt-prompt-submit.js";

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("mergeOrphanedTrailingUserPrompt", () => {
  it("keeps structured media and JSON summaries on UTF-16 boundaries", () => {
    const result = mergeOrphanedTrailingUserPrompt({
      prompt: "Continue.",
      trigger: "user",
      leafMessage: {
        content: [
          {
            type: "image_url",
            image_url: { url: `${"u".repeat(299)}😀tail` },
          },
          {
            type: "custom",
            value: `${"v".repeat(299)}😀tail`,
          },
          {
            [`${"k".repeat(997)}😀tail`]: 1,
          },
        ],
      },
    });

    expect(result.merged).toBe(true);
    expect(hasLoneSurrogate(result.prompt)).toBe(false);
    expect(result.prompt).not.toContain("\\ud83d");
    expect(result.prompt).toContain("[image_url]");
    expect(result.prompt).toContain("chars)");
  });
});

describe("resolvePromptSubmissionSkipReason", () => {
  it("skips empty prompt submissions without history or images", () => {
    // Empty visible prompt plus no useful replay context should not start a
    // model request.
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "   ",
        messages: [],
        imageCount: 0,
      }),
    ).toBe("empty_prompt_history_images");
  });

  it("skips blank visible user prompt submissions even when replay history exists", () => {
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "   ",
        messages: [{ role: "user", content: "previous turn", timestamp: 1 }],
        imageCount: 0,
      }),
    ).toBe("blank_user_prompt");
  });

  it("treats system/tool-only replay as empty history for blank submissions", () => {
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "   ",
        messages: [
          { role: "system", content: "runtime-only policy" },
          { role: "toolResult", content: "old tool output", toolCallId: "call-1" },
        ],
        imageCount: 0,
      }),
    ).toBe("empty_prompt_history_images");
  });

  it("treats empty user and assistant placeholders as empty history", () => {
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "   ",
        messages: [
          { role: "user", content: "   " },
          { role: "assistant", content: [] },
        ],
        imageCount: 0,
      }),
    ).toBe("empty_prompt_history_images");
  });

  it("allows text or image prompt submissions", () => {
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "hello",
        messages: [],
        imageCount: 0,
      }),
    ).toBeNull();
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "   ",
        messages: [],
        imageCount: 1,
      }),
    ).toBeNull();
  });

  it("skips blank prompt on runtimeOnly turns", () => {
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "",
        messages: [],
        runtimeOnly: true,
        imageCount: 0,
      }),
    ).toBe("empty_prompt_history_images");
  });

  it("treats undefined runtimeOnly as a visible user submission", () => {
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "",
        messages: [],
        runtimeOnly: undefined,
        imageCount: 0,
      }),
    ).toBe("empty_prompt_history_images");
  });
});

describe("resolvePromptBuildHookResult drain cache", () => {
  it("preserves an explicit empty per-turn tool allowlist", async () => {
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockReset();
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValue({
      queuedInjections: [],
    });
    const runBeforePromptBuild = vi.fn(async () => ({ toolsAllow: [] }));

    const result = await resolvePromptBuildHookResult({
      config: {},
      prompt: "answer without tools",
      messages: [],
      hookCtx: { runId: "tools-allow-run", sessionKey: "agent:main:main" },
      hookRunner: {
        hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
        runBeforePromptBuild,
      },
    });

    expect(result.toolsAllow).toEqual([]);
    expect(runBeforePromptBuild).toHaveBeenCalledOnce();
    forgetPromptBuildDrainCacheForRun("tools-allow-run");
  });

  it("drains plugin next-turn injections at most once per runId across retry attempts", async () => {
    // Retry attempts reuse the first drain result so plugin-provided next-turn
    // context is not consumed or duplicated multiple times.
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockReset();
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValue({
      queuedInjections: [
        {
          id: "inj-1",
          pluginId: "demo",
          text: "first attempt context",
          placement: "prepend_context",
          createdAt: 1,
        },
      ],
      prependContext: "first attempt context",
    });
    forgetPromptBuildDrainCacheForRun("run-cache-test");

    const hookCtx = { runId: "run-cache-test", sessionKey: "global", agentId: "qa" };

    const first = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx,
    });
    const second = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx,
    });

    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(1);
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledWith({
      cfg: {},
      sessionKey: "global",
      agentId: "qa",
    });
    expect(first.prependContext).toBe("first attempt context");
    expect(second.prependContext).toBe("first attempt context");

    forgetPromptBuildDrainCacheForRun("run-cache-test");
  });

  it("re-drains after the run-scoped cache is forgotten", async () => {
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockReset();
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValueOnce({
      queuedInjections: [],
      prependContext: undefined,
    });
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValueOnce({
      queuedInjections: [],
      prependContext: undefined,
    });

    const hookCtx = { runId: "run-evict-test", sessionKey: "agent:main:main" };

    await resolvePromptBuildHookResult({ config: {}, prompt: "hi", messages: [], hookCtx });
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(1);

    forgetPromptBuildDrainCacheForRun("run-evict-test");

    await resolvePromptBuildHookResult({ config: {}, prompt: "hi", messages: [], hookCtx });
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(2);
  });

  it("drains every call when no runId is provided (no caching key)", async () => {
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockReset();
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValue({
      queuedInjections: [],
      prependContext: undefined,
    });

    await resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx: { sessionKey: "agent:main:main" },
    });
    await resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx: { sessionKey: "agent:main:main" },
    });

    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(2);
  });
});

describe("buildAfterTurnRuntimeContext", () => {
  it("uses primary model when compaction.model is not set", () => {
    const runtimeAuthPlan = {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      harnessAuthProvider: "openai",
      forwardedAuthProfileId: "openai:p1",
      forwardedAuthProfileSource: "user" as const,
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authRequirement: "subscription" as const,
        requestTransportOverrides: "none" as const,
      },
    };
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        admittedRunContext: createTestAdmittedRunContext("run-after-turn-context"),
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        authProfileIdSource: "user",
        runtimePlan: { auth: runtimeAuthPlan } as never,
        config: {} as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      cwd: "/tmp/task-repo",
      agentDir: "/tmp/agent",
    });

    expect(legacy.provider).toBe("openai");
    expect(legacy.model).toBe("gpt-5.4");
    expect(legacy.authProfileIdSource).toBe("user");
    expect(legacy.runtimeAuthPlan).toBe(runtimeAuthPlan);
  });

  it("keeps the primary model for a locked after-turn runtime context", () => {
    const runtimeContext = buildAfterTurnRuntimeContext({
      attempt: {
        admittedRunContext: createTestAdmittedRunContext("run-after-turn-context"),
        sessionKey: "agent:main:session:locked",
        sandboxSessionKey: "global",
        sandboxAgentId: "main",
        config: {
          agents: { defaults: { compaction: { model: "anthropic/claude-opus-4-6" } } },
        } as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.5",
        agentHarnessId: "openclaw",
        modelSelectionLocked: true,
        thinkLevel: "off",
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    expect(runtimeContext.modelSelectionLocked).toBe(true);
    expect(runtimeContext.sandboxSessionKey).toBe("global");
    expect(runtimeContext.sandboxAgentId).toBe("main");
    expect(runtimeContext.provider).toBe("openai");
    expect(runtimeContext.model).toBe("gpt-5.5");
  });

  it("publishes the storage-neutral session target in runtime context", () => {
    const sessionTarget = {
      agentId: "main",
      sessionId: "session-abc",
      sessionKey: "agent:main:session:abc",
      storePath: "/tmp/state/agents/main/sessions/sessions.json",
      threadId: 42,
    };

    const runtimeContext = buildAfterTurnRuntimeContext({
      attempt: {
        admittedRunContext: createTestAdmittedRunContext("run-after-turn-context"),
        sessionId: "ignored-session-id",
        sessionKey: "agent:main:fallback",
        sessionTarget,
        config: {} as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      activeAgentId: "main",
    });

    expect(runtimeContext.transcriptStorage).toEqual({ kind: "sqlite" });
    expect(runtimeContext.sessionTarget).toEqual(sessionTarget);
  });
  it("resolves compaction.model override in runtime context so all context engines use the correct model", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        admittedRunContext: createTestAdmittedRunContext("run-after-turn-context"),
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: {
          agents: {
            defaults: {
              models: {
                "openrouter/anthropic/claude-sonnet-4-5": {
                  alias: "summary",
                },
              },
              compaction: {
                model: "summary",
              },
            },
          },
        } as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      cwd: "/tmp/task-repo",
      agentDir: "/tmp/agent",
    });

    // Resolve aliases before handing runtime context to any context engine;
    // otherwise third-party engines can dispatch the bare alias as a model id.
    expect(legacy.provider).toBe("openrouter");
    expect(legacy.model).toBe("anthropic/claude-sonnet-4-5");
    // Auth profile dropped because provider changed from openai to openrouter.
    expect(legacy.authProfileId).toBeUndefined();
  });
  it("includes resolved auth profile fields for context-engine afterTurn compaction", () => {
    const promptCache = buildContextEnginePromptCacheInfo({
      lastCallUsage: {
        input: 10,
        output: 5,
        cacheRead: 40,
        cacheWrite: 2,
        total: 57,
      },
    });
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        admittedRunContext: createTestAdmittedRunContext("run-after-turn-context"),
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: { plugins: { slots: { contextEngine: "lossless-claw" } } } as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      cwd: "/tmp/task-repo",
      agentDir: "/tmp/agent",
      tokenBudget: 1050000,
      currentTokenCount: 52,
      promptCache,
    });

    expect(legacy.authProfileId).toBe("openai:p1");
    expect(legacy.provider).toBe("openai");
    expect(legacy.model).toBe("gpt-5.4");
    expect(legacy.workspaceDir).toBe("/tmp/workspace");
    expect(legacy.cwd).toBe("/tmp/task-repo");
    expect(legacy.agentDir).toBe("/tmp/agent");
    expect(legacy.tokenBudget).toBe(1050000);
    expect(legacy.currentTokenCount).toBe(52);
    expect(legacy.promptCache?.lastCallUsage?.total).toBe(57);
  });

  it("derives afterTurn token count from the current assistant usage snapshot", () => {
    const lastCallUsage = {
      input: 10,
      output: 5,
      cacheRead: 40,
      cacheWrite: 2,
      contextUsage: {
        state: "available",
        promptTokens: 23,
        totalTokens: 28,
      },
      total: 57,
    } satisfies NormalizedUsage;
    const promptCache = buildContextEnginePromptCacheInfo({ lastCallUsage });
    const legacy = buildAfterTurnRuntimeContextFromUsage({
      attempt: {
        admittedRunContext: createTestAdmittedRunContext("run-after-turn-context"),
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: { plugins: { slots: { contextEngine: "lossless-claw" } } } as OpenClawConfig,
        skillsSnapshot: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      tokenBudget: 1050000,
      lastCallUsage,
      promptCache,
    });

    expect(legacy.currentTokenCount).toBe(23);
    expect(legacy.promptCache?.lastCallUsage?.total).toBe(57);
  });

  it("preserves sender and channel routing context for scoped compaction discovery", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        admittedRunContext: createTestAdmittedRunContext("run-after-turn-context"),
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        currentChannelId: "C123",
        currentThreadTs: "thread-9",
        currentMessageId: "msg-42",
        authProfileId: "openai:p1",
        config: {} as OpenClawConfig,
        skillsSnapshot: undefined,
        senderId: "user-123",
        provider: "openai",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    expect(legacy.senderId).toBe("user-123");
    expect(legacy.currentChannelId).toBe("C123");
    expect(legacy.currentThreadTs).toBe("thread-9");
    expect(legacy.currentMessageId).toBe("msg-42");
  });
});
