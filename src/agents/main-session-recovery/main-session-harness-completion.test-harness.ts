import path from "node:path";
import type { Mock } from "vitest";
import { expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { buildCurrentRunRestartRecoveryClaim } from "../agent-command-restart-recovery.js";
import { captureAdmittedHarnessCompletionForTest } from "../agent-harness-completion.test-support.js";
import type { SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";

type HarnessRecoveryFixture = {
  tmpDir: string;
  makeSessionsDir: (agentId?: string) => Promise<string>;
  mainSessionEntry: (overrides?: SessionEntryFixture) => SessionEntry;
  runningSessionEntry: (sessionId: string, overrides?: SessionEntryFixture) => SessionEntry;
  writeStore: (sessionsDir: string, store: Record<string, SessionEntryFixture>) => Promise<void>;
  writeTranscript: (
    sessionsDir: string,
    sessionId: string,
    messages: readonly unknown[],
  ) => Promise<void>;
  expectRecovery: (expected: {
    started: number;
    settled: number;
    failed: number;
    skipped: number;
  }) => Promise<void>;
  loadSessionEntry: (scope: Parameters<typeof loadSessionEntry>[0]) => SessionEntry | undefined;
  sendRecoveryNotice: Mock<GatewayRecoveryRuntime["sendRecoveryNotice"]>;
  dispatchSettlement: { resolve: () => void };
  discordDeliveryContext: { readonly channel: "discord"; readonly to: string };
  gatewayParams: () => Record<string, unknown>;
};

export function registerHarnessCompletionRecoveryCases(
  getFixture: () => HarnessRecoveryFixture,
): void {
  it.each([
    "initial",
    "recovery",
    "long-initial",
    "long-recovery",
    "missing-source",
    "reserved-successor",
    "human-before-recovery",
  ])(
    "recovers the admitted harness completion after %s execution is interrupted",
    async (phase) => {
      const {
        tmpDir,
        makeSessionsDir,
        mainSessionEntry,
        writeStore,
        writeTranscript,
        expectRecovery,
        loadSessionEntry,
        dispatchSettlement,
        discordDeliveryContext,
      } = getFixture();
      await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
        const sessionsDir = await makeSessionsDir();
        const sessionKey = "agent:main:main";
        const taskRunId = "harness:child-1";
        const sourceRunId = "announce:harness:parent:child-1:succeeded";
        const provenance = {
          kind: "inter_session",
          sourceTool: "agent_harness_task",
          sourceChannel: "internal",
          sourceSessionKey: taskRunId,
        } as const;
        const entry = mainSessionEntry({ lifecycleRevision: "revision-1" });
        const binding = await captureAdmittedHarnessCompletionForTest({
          agentId: "main",
          sessionKey,
          entry,
          runId: sourceRunId,
          inputProvenance: provenance,
        });
        expect(binding).toBeDefined();
        const original = {
          ...entry,
          ...buildCurrentRunRestartRecoveryClaim({
            entry,
            runId: sourceRunId,
            sourceRunId,
            sourceIngress: "internal",
            sourceReplyDeliveryMode: "automatic",
            deliveryContext: discordDeliveryContext,
            harnessCompletion: binding,
          }),
        };
        const operationalRunId =
          phase === "reserved-successor"
            ? "recovery-R2"
            : phase.endsWith("recovery")
              ? "recovery-R"
              : sourceRunId;
        await writeStore(sessionsDir, {
          [sessionKey]: {
            ...original,
            restartRecoveryDeliveryRunId: operationalRunId,
            ...(phase === "reserved-successor"
              ? {
                  restartRecoveryRuns: [
                    { runId: "recovery-R", lifecycleGeneration: "prior-gateway" },
                  ],
                }
              : {}),
          },
        });
        await writeTranscript(sessionsDir, entry.sessionId, [
          {
            role: "user",
            content: "Background work finished",
            idempotencyKey:
              phase === "missing-source" ? "unrelated-input:user" : `${sourceRunId}:user`,
            __openclaw: { runId: sourceRunId },
            provenance,
          },
          ...(phase === "human-before-recovery"
            ? [{ role: "user", content: "stop that completion and work on my new request" }]
            : []),
          ...(phase.endsWith("recovery") || phase === "reserved-successor"
            ? [
                {
                  role: "user",
                  content: "Continue interrupted reply",
                  __openclaw: {
                    runId: phase === "reserved-successor" ? "recovery-R" : operationalRunId,
                  },
                  provenance: {
                    kind: "internal_system",
                    sourceTool: "main_session_restart_recovery",
                    sourceSessionKey: sessionKey,
                  },
                },
              ]
            : []),
          ...(phase.startsWith("long-")
            ? Array.from({ length: 40 }, (_, index) => ({
                role: "assistant",
                content: `intermediate ${index}`,
              }))
            : []),
        ]);
        if (phase === "missing-source" || phase === "human-before-recovery") {
          await expectRecovery({ started: 0, settled: 0, failed: 1, skipped: 0 });
          expect(callGateway).not.toHaveBeenCalled();
          expect(
            loadSessionEntry({ sessionKey, storePath: path.join(sessionsDir, "sessions.json") }),
          ).toMatchObject({
            status: "running",
            restartRecoveryHarnessCompletion: binding,
            restartRecoveryDeliverySourceRunId: sourceRunId,
          });
          return;
        }
        await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
        expect(callGateway).toHaveBeenCalledOnce();
        const saved = loadSessionEntry({
          sessionKey,
          storePath: path.join(sessionsDir, "sessions.json"),
        });
        expect(saved?.restartRecoveryHarnessCompletion).toEqual(binding);
        expect(saved?.restartRecoveryDeliverySourceRunId).toBe(sourceRunId);
        expect(saved?.restartRecoveryDeliveryRunId).not.toBe(sourceRunId);
        dispatchSettlement.resolve();
      });
    },
  );

  it("resumes an explicit human run despite stale completion provenance", async () => {
    const {
      makeSessionsDir,
      writeStore,
      writeTranscript,
      expectRecovery,
      runningSessionEntry,
      gatewayParams,
    } = getFixture();
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:telegram:group:-100:topic:41818";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        ...runningSessionEntry("topic-41818-session"),
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "human-run-2", lifecycleGeneration: "generation-old" }],
      },
    });
    await writeTranscript(sessionsDir, "topic-41818-session", [
      {
        role: "user",
        content: "A background task finished.",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceChannel: "internal",
          sourceTool: "subagent_announce",
        },
      },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().sessionKey).toBe(sessionKey);
  });
}
