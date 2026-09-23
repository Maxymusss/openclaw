import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveAdmittedRunSessionFile } from "./agent-runner-core.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import type { PreparedReplyRunContext } from "./get-reply-run-context.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { createReplyModelLevelResolver } from "./reply-model-levels.js";
import { resolveFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthSelection: async () => undefined,
}));
vi.mock("./session-system-events.js", () => ({
  drainFormattedSystemEvents: async () => undefined,
}));
vi.mock("./get-reply-run-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./get-reply-run-helpers.js")>()),
  loadAgentRunnerRuntime: async () => ({ runReplyAgent: vi.fn() }),
  loadEmbeddedAgentRuntime: async () => ({
    resolveActiveEmbeddedRunSessionId: () => undefined,
    resolveActiveEmbeddedRunSessionIdBySessionFile: () => undefined,
    resolveEmbeddedSessionLane: () => undefined,
  }),
  loadSessionUpdatesRuntime: async () => ({
    ensureSkillSnapshot: async ({ sessionEntry }: { sessionEntry: SessionEntry }) => ({
      sessionEntry,
    }),
  }),
}));

// Exercise the producer before execution: queued admission later normalizes the
// same transcript to its scoped key, which must not change tool authority.
describe("prepared reply transcript identity", () => {
  it.each([false, true])(
    "keeps incoming authority and prompt intent when thinking is deferred=%s",
    async (deferred) => {
      const sessionKey = "agent:main:slack:channel:room:thread:100.1";
      const sessionId = "session";
      const entry: SessionEntry = { sessionId, updatedAt: 1 };
      const ctx = { SessionKey: sessionKey, Provider: "slack", ChatType: "channel" };
      const modelState = createModelSelectionStateFixture({
        provider: "anthropic",
        model: "claude",
        agentCfg: undefined,
      });
      const resolveThinkingCatalog = vi.fn(async () => []);
      const deferredReplyModelLevels = deferred
        ? createReplyModelLevelResolver({
            modelState,
            selection: {
              provider: "anthropic",
              model: "claude",
              thinkingExplicit: false,
              reasoningLevel: "off",
              reasoningExplicit: false,
            },
          }).defer()
        : undefined;
      const body = deferred ? "high keep this prompt" : "Use the revised request";
      const context = {
        params: {
          ctx,
          sessionCtx: ctx,
          cfg: {},
          agentId: "main",
          agentDir: "/tmp/agent",
          directives: {},
          modelState: { ...modelState, resolveThinkingCatalog },
          provider: "anthropic",
          model: "claude",
          typing: { cleanup: vi.fn() },
          sessionKey,
          sessionId,
          storePath: "/tmp/agent/sessions/sessions.json",
          sessionStore: { [sessionKey]: entry },
          resolvedThinkLevel: deferred ? undefined : "off",
          deferredReplyModelLevels,
        },
        sessionEntry: entry,
        traceRunPhase: <T>(_name: string, run: () => T) => run(),
        baseBodyFinal: body,
        prefixedBodyBase: body,
        hasUserBody: true,
        workspaceDir: "/tmp/workspace",
        skillsWorkspaceDir: "/tmp/workspace",
        useFastReplyRuntime: false,
        thinkingRuntime: "embedded",
        getInboundContext: () => ({ inboundUserContext: "" }),
        getSessionEntry: () => entry,
      } as unknown as PreparedReplyRunContext;
      const prepared = await prepareReplyRunAdmission(context);
      expect(prepared.kind).toBe("ready");
      if (prepared.kind !== "ready") {
        throw new Error("Expected a prepared reply");
      }
      if (deferred) {
        expect(prepared.prefixedCommandBody).toContain(body);
        expect(prepared.resolvedThinkLevel).toBeUndefined();
        expect(prepared.deferredReplyModelLevels).toBeDefined();
        expect(resolveThinkingCatalog).not.toHaveBeenCalled();
      }
      const incoming = createQueueTestRun({ prompt: "Use the revised request" });
      incoming.run = {
        ...incoming.run,
        agentId: "main",
        sessionKey,
        sessionId,
        sessionFile: prepared.preparedSessionState.sessionFile,
      };
      const queued = {
        ...incoming,
        run: {
          ...incoming.run,
          sessionFile: resolveAdmittedRunSessionFile({ ...incoming.run })!,
        },
      };
      expect(resolveFollowupRunToolAuthorityFingerprint(incoming)).toBe(
        resolveFollowupRunToolAuthorityFingerprint(queued),
      );
      expect(prepared.preparedSessionState.sessionFile).toBe(sessionKey);
    },
  );
});
