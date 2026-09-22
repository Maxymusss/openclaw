/** Registered Nodes tool -> Gateway handler/registry -> node command -> native fixture. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { wrapToolWithBeforeToolCallHook } from "../../agents/agent-tools.before-tool-call.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createNodesTool } from "../../agents/tools/nodes-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveExecApprovals } from "../../infra/exec-approvals.js";
import { prepareLinuxInstalledApp } from "../../infra/installed-apps-linux.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  authorizeObservedClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
} from "../../talk/client-voice-confirmation.js";
import {
  noteClientVoiceConfirmationUtteranceForTest,
  resetClientVoiceConfirmationStateForTest,
  snapshotClientVoiceConfirmationStateForTest,
} from "../../talk/client-voice-confirmation.test-support.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { NodeRegistry } from "../node-registry.js";
import { resetNodeWakeStateForTest } from "../node-wake-state.test-support.js";
import { nodeInvokeHandlers } from "../server-methods/nodes.invoke.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { captureTalkVoiceOrigin } from "./client-voice-origin.js";
import { createInstalledAppLoopbackTransport } from "./installed-app-loopback.test-support.js";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: mocks.rpc,
  readGatewayCallOptions: () => ({}),
  shouldUseInProcessGatewayTool: () => true,
}));
vi.mock("../../infra/device-pairing-node-state.js", () => ({
  captureNodePairingGeneration: async () => ({ nodeId: "paired-node", key: "generation" }),
  isNodePairingGenerationCurrent: async () => true,
}));

afterEach(() => {
  clientVoiceSessionTesting.reset();
  resetClientVoiceConfirmationStateForTest();
  resetNodeWakeStateForTest();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.runIf(process.platform === "linux")("registered installed-app voice flow", () => {
  it.each([
    "launch",
    "policy-revoked-before-ready",
    "node-denied",
    "policy-revoked-after-spawn",
    "origin-revoked-after-spawn",
    "spoken-grant-policy-after-spawn",
  ] as const)("first-use inventory and exact launch: %s", async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const lateSettlement = mode.endsWith("after-spawn");
      let nodeSpawnAcknowledged = false;
      setActivePluginRegistry(createEmptyPluginRegistry());
      const data = state.path("app-data");
      fs.mkdirSync(path.join(data, "applications"), { recursive: true });
      const executable = state.path("native-fixture");
      fs.copyFileSync(process.execPath, executable);
      fs.chmodSync(executable, 0o755);
      fs.writeFileSync(
        path.join(data, "applications", "fixture.desktop"),
        ["[Desktop Entry]", "Type=Application", "Name=Calculator", "Exec=" + executable, ""].join(
          "\n",
        ),
      );
      vi.stubEnv("XDG_DATA_HOME", data);
      vi.stubEnv("XDG_DATA_DIRS", data);
      const app = prepareLinuxInstalledApp("linux-desktop:fixture.desktop")!.app;
      let config: OpenClawConfig = {
        gateway: {
          nodes: {
            commands: {
              allow: ["device.apps.launch"],
              ...(mode === "node-denied" ? { deny: ["device.apps.launch"] } : {}),
            },
          },
        },
        talk: {
          realtime: {
            appLaunchPolicies: [
              {
                id: "calculator",
                agentId: "main",
                originatingDeviceId: "widget",
                nodeId: "paired-node",
                appId: app.appId,
                appRevision: app.appRevision,
                expiresAtMs: Date.now() + 60000,
              },
            ],
          },
        },
      };
      const policyConfig = config;
      setRuntimeConfigSnapshot(config, config);
      saveExecApprovals({
        version: 1,
        agents: {
          main: { security: "allowlist", ask: "off", allowlist: [{ pattern: executable }] },
        },
      });
      const revokePolicy = () => {
        config = {
          ...config,
          talk: {
            ...config.talk,
            realtime: { ...config.talk?.realtime, appLaunchPolicies: [] },
          },
        };
        setRuntimeConfigSnapshot(config, config);
      };
      const registry = new NodeRegistry({
        getConfig: () => config,
        resolveCurrentPairingState: async () => ({
          identity: "pairing",
          generation: "generation",
        }),
        isPairingStateCurrent: () => true,
      });
      const { node, nativeCommands, permits, drain } = createInstalledAppLoopbackTransport(
        registry,
        {
          beforeProgress: () => {
            if (mode === "policy-revoked-before-ready") {
              revokePolicy();
            }
            if (mode === "spoken-grant-policy-after-spawn") {
              // Generic wrapper authorization must not spend the grant during preparation.
              expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(1);
            }
          },
          beforeResult: lateSettlement
            ? (command, result) => {
                if (command !== "device.apps.launch") {
                  return;
                }
                // The real node adapter returns this only after the OS spawn event.
                expect(result).toMatchObject({ ok: true });
                expect(JSON.stringify(result)).toContain("Installed application launch dispatched");
                nodeSpawnAcknowledged = true;
                if (mode === "origin-revoked-after-spawn") {
                  invalidateGatewayDeviceRevocation(context, "widget", "operator");
                } else {
                  revokePolicy();
                }
              }
            : undefined,
        },
      );
      registry.register(node, {
        pairingIdentity: "pairing",
        pairingGeneration: "generation",
        approvedSurface: { caps: ["device"], commands: ["device.apps", "device.apps.launch"] },
      });
      const context = {
        nodeRegistry: registry,
        getRuntimeConfig: () => config,
        logGateway: { info: vi.fn(), warn: vi.fn() },
      } as unknown as GatewayRequestHandlerOptions["context"];
      mocks.rpc.mockImplementation(
        async (method: string, _options: unknown, params: Record<string, unknown>) => {
          if (method === "node.list") {
            return {
              nodes: registry.listConnected().map((entry) => ({
                nodeId: entry.nodeId,
                commands: entry.commands,
                connected: true,
              })),
            };
          }
          if (method !== "node.invoke") {
            throw new Error("unexpected RPC " + method);
          }
          return await new Promise((resolve, reject) => {
            void Promise.resolve(
              nodeInvokeHandlers["node.invoke"]!({
                req: { type: "req", id: "app-rpc", method },
                params: {
                  ...params,
                  ...(lateSettlement && params.command === "device.apps.launch"
                    ? { timeoutMs: 2000 }
                    : {}),
                },
                context,
                client: null,
                isWebchatConnect: () => false,
                respond: (ok, payload, error) =>
                  ok
                    ? resolve(payload)
                    : reject(new Error(error?.message ?? "node invocation denied")),
              }),
            ).catch(reject);
          });
        },
      );
      const sessionKey = "agent:main:registered-app";
      const ingress = captureGatewayDeviceRevocation(
        context,
        { deviceId: "widget", role: "operator" },
        () => true,
      );
      const origin = captureTalkVoiceOrigin({
        client: { ...sharingPolicyClient({ deviceId: "widget" }), isDeviceTokenAuth: true },
        hasCurrentClientAuthority: ingress.isCurrent,
      });
      const voiceSessionId = createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
        transcriptCapable: true,
      });
      ingress.release();
      const admission = prepareSystemAgentRunAdmission(
        config,
        "registered-app-run",
        "main",
        "app-test",
      );
      try {
        const admitted = await admission.admit("embedded");
        registerClientVoiceConsultRun({
          originAuthority: origin,
          agentId: "main",
          sessionKey,
          voiceSessionId,
          runId: "registered-app-run",
        });
        const tool = wrapToolWithBeforeToolCallHook(
          createNodesTool({ agentId: "main", agentSessionKey: sessionKey, config }),
          { agentId: "main", sessionKey, runId: "registered-app-run" },
        );
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            operationalRunInstance: admitted.operationalRunInstance,
          },
          async () => {
            const listing = await tool.execute("inventory", {
              action: "app_list",
              node: "paired-node",
              query: "Calculator",
            });
            const listed = (
              listing.details as {
                payload: { apps: Array<{ appId: string; appRevision: string }> };
              }
            ).payload.apps[0]!;
            expect(listed.appId).toBe(app.appId);
            const launchParams = {
              action: "app_launch",
              node: "paired-node",
              appId: listed.appId,
              appRevision: listed.appRevision,
            };
            if (mode === "spoken-grant-policy-after-spawn") {
              revokePolicy();
              const blocked = await tool
                .execute("needs-confirmation", { ...launchParams })
                .catch((error: unknown) => ({ error: String(error) }));
              expect(JSON.stringify(blocked)).toContain("VOICE_CONFIRMATION_REQUIRED");
              const spokenAt = Date.now() + 1;
              noteClientVoiceConfirmationUtteranceForTest({
                agentId: "main",
                voiceSessionId,
                text: "yes",
                timestamp: spokenAt,
              });
              const grant = authorizeObservedClientVoiceConfirmation({
                agentId: "main",
                voiceSessionId,
                now: spokenAt + 1,
              });
              if (!grant) {
                throw new Error(
                  "Expected the persisted spoken affirmation to authorize the action",
                );
              }
              expect(
                bindAuthorizedClientVoiceConfirmation({
                  grant,
                  runId: "registered-app-run",
                  now: spokenAt + 1,
                }),
              ).toBe(true);
              // An operator adds a matching policy after confirmation, before execution.
              config = policyConfig;
              setRuntimeConfigSnapshot(config, config);
            }
            const launching = tool.execute("launch", { ...launchParams });
            if (mode === "launch" || lateSettlement) {
              const outcome = await launching.then(
                (value) => ({ value, error: undefined }),
                (error: unknown) => ({ value: undefined, error }),
              );
              if (lateSettlement) {
                expect(nodeSpawnAcknowledged).toBe(true);
              }
              expect(outcome.error).toBeUndefined();
              const launch = outcome.value;
              expect(JSON.stringify(launch)).toContain("Installed application launch dispatched");
              expect(permits).toEqual([
                { type: "installed-app-launch.allow", validForMs: expect.any(Number) },
              ]);
              expect(
                clientVoiceSessionTesting
                  .readRecord("main", voiceSessionId)
                  ?.effects.find((entry) => entry.toolCallId === "launch")?.voicePolicyId,
              ).toBe("calculator");
              if (lateSettlement) {
                const next = await tool
                  .execute("launch-after-revocation", { ...launchParams })
                  .catch((error: unknown) => ({ error: String(error) }));
                expect(
                  nativeCommands.filter((command) => command === "device.apps.launch"),
                ).toHaveLength(1);
                expect(JSON.stringify(next)).toContain("VOICE_CONFIRMATION_REQUIRED");
              }
            } else {
              await expect(launching).rejects.toThrow(
                mode === "node-denied"
                  ? /does not advertise|not allow|denied/
                  : /VOICE_CONFIRMATION_REQUIRED/,
              );
              expect(
                permits.some(
                  (permit) => (permit as { type: string }).type === "installed-app-launch.allow",
                ),
              ).toBe(false);
            }
          },
        );
        expect(nativeCommands[0]).toBe("device.apps");
        if (mode === "node-denied") {
          expect(nativeCommands).toEqual(["device.apps"]);
        }
      } finally {
        origin?.release();
        admission.close();
        registry.unregister("node-connection");
        await drain();
      }
    });
  });
});
