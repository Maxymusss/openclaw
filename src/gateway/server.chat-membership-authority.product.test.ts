import { randomUUID, X509Certificate } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "carries current membership through transcript persistence and agent dispatch",
  { timeout: 90_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "chat-membership-authority",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    });
    const requests: string[] = [];
    const providerErrors: unknown[] = [];
    const providerServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        requests.push(Buffer.concat(chunks).toString("utf8"));
        writeOpenAiResponsesText(response, {
          text: "Authorized member reply.",
          messageId: `msg_${randomUUID()}`,
          responseId: `resp_${randomUUID()}`,
        });
      })().catch((error: unknown) => {
        providerErrors.push(error);
        response.writeHead(500).end("fixture provider failed");
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("fixture provider did not bind");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "membership-authority",
      );
      const proxyUser = "membership-authority-member@example.test";
      const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
      const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
      const trustedProxy = {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowUsers: [proxyUser],
        allowLoopback: true,
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.read", "operator.write"],
        },
      };
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: {
              ...provider.config,
              request: { allowPrivateNetwork: true },
            },
          },
        },
        plugins: { enabled: false, slots: { memory: "none" } },
        tools: { profile: "minimal" },
        gateway: {
          auth: { mode: "trusted-proxy", trustedProxy },
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: ["https://control.example.com"] },
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          roles: {
            default: "view",
            definitions: {
              view: {
                sessions: { others: "view" },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      } satisfies OpenClawConfig;
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        portClaim,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        auth: { mode: "trusted-proxy", trustedProxy },
        edgeAuthHeaders: {
          "x-forwarded-for": "203.0.113.50",
          "x-forwarded-proto": "https",
          "x-forwarded-user": proxyUser,
        },
        origin: "https://control.example.com",
        secure: true,
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        scopes: ["operator.read", "operator.write"],
      });
      await gateway.server.startupSettled;
      const self = await gateway.client.request<UsersSelfResult>("users.self", {});
      const memberProfileId = self.profile.id;
      const sessionKey = `agent:main:member-authority-${randomUUID()}`;
      const sessionId = `member-authority-${randomUUID()}`;
      const scope = { agentId: "main", sessionKey, sessionId };
      const owner = ensureProfileForEmail("membership-authority-owner@example.test");
      await replaceSessionEntry(scope, {
        sessionId,
        updatedAt: Date.now(),
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      await addSessionMember(scope, { identityId: memberProfileId, addedBy: owner.id });

      const allowedMessage = "Persist and dispatch this authorized member turn.";
      const accepted = await gateway.client.request<{ runId: string; status: string }>(
        "chat.send",
        {
          sessionKey,
          message: allowedMessage,
          deliver: false,
          idempotencyKey: randomUUID(),
        },
      );
      expect(accepted.status).toBe("started");
      await expect(
        gateway.client.request<{ status: string }>(
          "agent.wait",
          { runId: accepted.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        ),
      ).resolves.toMatchObject({ status: "ok" });
      const allowedTranscript = await loadTranscriptEvents(scope);
      expect(JSON.stringify(allowedTranscript)).toContain(allowedMessage);
      expect(JSON.stringify(allowedTranscript)).toContain("Authorized member reply.");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(allowedMessage);
      expect(providerErrors).toEqual([]);

      await removeSessionMember(scope, memberProfileId);
      const transcriptBeforeDeniedTurn = structuredClone(await loadTranscriptEvents(scope));
      await expect(
        gateway.client.request("chat.send", {
          sessionKey,
          message: "This revoked member turn must have no effects.",
          deliver: false,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(await loadTranscriptEvents(scope)).toEqual(transcriptBeforeDeniedTurn);
      expect(requests).toHaveLength(1);
      expect(providerErrors).toEqual([]);
    } finally {
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "membership authority proof complete" });
        }
      } finally {
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
        await state.cleanup();
      }
    }
  },
);
