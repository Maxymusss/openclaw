import { execFileSync } from "node:child_process";
/** Real policy recorder/router/node command and native ELF effect. Only the node wire is in-memory. */
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureNodePairingState,
  resolveCurrentPairedDeviceNodeBinding,
  isPairedDeviceNodeBindingCurrent,
} from "../../infra/device-pairing-node-state.js";
import { requestNodePairing, approveNodePairing } from "../../infra/device-pairing-node.js";
import { seedNodeDevice } from "../../infra/device-pairing-node.test-support.js";
import { saveExecApprovals } from "../../infra/exec-approvals.js";
import { prepareLinuxInstalledApp } from "../../infra/installed-apps-linux.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { captureGatewayDeviceRevocation } from "../device-revocation.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { captureTalkVoiceOrigin } from "./client-voice-origin.js";
import { createInstalledAppLoopbackTransport } from "./installed-app-loopback.test-support.js";

export async function createNativeAppPolicyFixture(
  state: OpenClawTestState,
  mode: "launch" | "policy-revoked-before-ready" | "node-denied" | "unapproved" = "launch",
  onPermit?: () => void,
) {
  const data = state.path("app-data");
  fs.mkdirSync(path.join(data, "applications"), { recursive: true });
  const executable = state.path("native-fixture");
  const marker = state.path("native-effects");
  const c = state.path("native-fixture.c");
  fs.writeFileSync(
    c,
    "#include <stdio.h>" +
      String.fromCharCode(10) +
      "int main(int argc,char**argv){if(argc!=1)return 2;FILE*f=fopen(" +
      JSON.stringify(marker) +
      ',"a");if(!f)return 3;fputs("effect",f);fputc(10,f);return fclose(f);}',
  );
  execFileSync("gcc", [c, "-o", executable]);
  fs.writeFileSync(
    path.join(data, "applications", "fixture.desktop"),
    ["[Desktop Entry]", "Type=Application", "Name=Calculator", "Exec=" + executable, ""].join("\n"),
  );
  vi.stubEnv("XDG_DATA_HOME", data);
  vi.stubEnv("XDG_DATA_DIRS", data);
  const app = prepareLinuxInstalledApp("linux-desktop:fixture.desktop")!.app;
  let config: OpenClawConfig = {
    gateway: {
      nodes: {
        commands: {
          allow: ["device.apps", "device.apps.launch"],
          ...(mode === "node-denied" ? { deny: ["device.apps.launch"] } : {}),
        },
      },
    },
    talk: {
      realtime: {
        appLaunchPolicies:
          mode === "unapproved"
            ? []
            : [
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
  setRuntimeConfigSnapshot(config, config);
  saveExecApprovals({
    version: 1,
    agents: {
      main: { security: "allowlist", ask: "off", allowlist: [{ pattern: executable }] },
    },
  });
  const registry = new NodeRegistry({
    getConfig: () => config,
    resolveCurrentPairingState: resolveCurrentPairedDeviceNodeBinding,
    isPairingStateCurrent: isPairedDeviceNodeBindingCurrent,
  });
  const { node, nativeCommands, permits, drain } = createInstalledAppLoopbackTransport(registry, {
    beforeProgress: () => {
      if (mode === "policy-revoked-before-ready") {
        config = {
          ...config,
          talk: {
            ...config.talk,
            realtime: { ...config.talk?.realtime, appLaunchPolicies: [] },
          },
        };
        setRuntimeConfigSnapshot(config, config);
      }
    },
    onAllowPermit: onPermit,
  });
  await seedNodeDevice(state.stateDir, "paired-node");
  const surface = await requestNodePairing(
    {
      nodeId: "paired-node",
      platform: "linux",
      caps: ["device"],
      commands: ["device.apps", "device.apps.launch"],
    },
    state.stateDir,
  );
  await approveNodePairing(
    surface.request.requestId,
    { callerScopes: ["operator.admin", "operator.pairing"] },
    state.stateDir,
  );
  const pairing = await captureNodePairingState("paired-node", state.stateDir);
  if (!pairing) {
    throw new Error("Missing actual paired node state");
  }
  registry.register(node, {
    pairingIdentity: pairing.identity.key,
    pairingGeneration: pairing.generation?.key,
    approvedSurface: { caps: ["device"], commands: ["device.apps", "device.apps.launch"] },
  });
  const context = {
    nodeRegistry: registry,
    trackExecution: (run: () => Promise<void>) => run(),
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    getRuntimeConfig: () => config,
    logGateway: { info: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestHandlerOptions["context"];

  const ingress = captureGatewayDeviceRevocation(
    context,
    { deviceId: "widget", role: "operator" },
    () => true,
  );
  const origin = captureTalkVoiceOrigin({
    client: { ...sharingPolicyClient({ deviceId: "widget" }), isDeviceTokenAuth: true },
    hasCurrentClientAuthority: ingress.isCurrent,
  });
  ingress.release();
  return {
    app,
    config: () => config,
    context,
    origin,
    nativeCommands,
    permits,
    effectCount: () =>
      fs.existsSync(marker)
        ? fs.readFileSync(marker, "utf8").split(String.fromCharCode(10)).filter(Boolean).length
        : 0,
    close: async () => {
      origin?.release();
      registry.unregister("node-connection");
      await drain();
    },
  };
}
