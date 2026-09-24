import type { IncomingHttpHeaders } from "node:http";
import { expect, it, vi } from "vitest";
import type WebSocket from "ws";
import type { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import type { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { parseMinimalGatewayRequestFrame } from "./minimal-gateway.test-helpers.js";

export type AcquisitionOwner = {
  signal: AbortSignal;
  track: ReturnType<typeof createFixtureLifetime>["track"];
  releases: Set<() => void>;
};

export type PeerBehavior =
  | "hold upgrade"
  | "reject upgrade"
  | "no challenge"
  | "no response"
  | "reject auth"
  | "reject auth without close"
  | "transport error"
  | "upgrade then transport error"
  | "hello then transport error"
  | "reply";

export type AcquisitionPeer = {
  port: number;
  clients: WebSocket[];
  closed: Set<WebSocket>;
  errors: Error[];
  unownedErrors: Error[];
  requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[];
  upgradeHeaders: IncomingHttpHeaders[];
  receivedUpgrade: () => boolean;
  waitForUpgrade: (signal: AbortSignal) => Promise<unknown>;
  waitForOpen: (signal: AbortSignal) => Promise<void>;
  waitForConnect: (signal: AbortSignal) => Promise<void>;
  isListening: () => boolean;
  failTransport: () => Promise<Error>;
  close: () => Promise<void>;
};

type AdapterPorts = {
  WebSocket: Pick<typeof WebSocket, "OPEN" | "CLOSED">;
  runAcquisitionCase: (
    options: Parameters<typeof withOpenClawTestState>[0],
    body: (
      state: Parameters<Parameters<typeof withOpenClawTestState>[1]>[0],
      owner: AcquisitionOwner,
    ) => Promise<void>,
  ) => Promise<void>;
  withAcquisitionPeer: (
    behavior: PeerBehavior,
    body: (peer: AcquisitionPeer) => Promise<void>,
    owner?: AcquisitionOwner,
  ) => Promise<void>;
  withAcquisitionCleanup: (
    body: () => Promise<void>,
    dispose: () => Promise<void>,
  ) => Promise<void>;
  mockPeerGateway: (peer: AcquisitionPeer) => unknown;
  verifyAcquisitionTimeout: (
    peer: AcquisitionPeer,
    timeoutMs: number,
    signal: AbortSignal,
    acquire: () => Promise<unknown>,
    verifyFailure: (failure: unknown) => void,
    phase?: "upgrade" | "challenge" | "response",
  ) => Promise<void>;
};

// Register under the existing acquisition scope so its mocks, owner and hooks stay shared.
export function registerGatewayAcquisitionAdapterTests({
  WebSocket,
  runAcquisitionCase,
  withAcquisitionPeer,
  withAcquisitionCleanup,
  mockPeerGateway,
  verifyAcquisitionTimeout,
}: AdapterPorts): void {
  it.for([
    { helper: "auth open", behavior: "hold upgrade", error: "timeout waiting for ws open" },
    { helper: "auth open", behavior: "reject upgrade", error: "Unexpected server response: 503" },
    { helper: "auth open", behavior: "upgrade then transport error", error: "invalid opcode 3" },
    { helper: "Tailscale", behavior: "hold upgrade", error: "timeout waiting for ws open" },
    { helper: "Tailscale", behavior: "reject upgrade", error: "Unexpected server response: 503" },
    { helper: "Tailscale", behavior: "upgrade then transport error", error: "invalid opcode 3" },
    { helper: "harness", behavior: "hold upgrade", error: "timeout waiting for ws open" },
    { helper: "harness", behavior: "reject upgrade", error: "Unexpected server response: 503" },
    { helper: "harness", behavior: "upgrade then transport error", error: "invalid opcode 3" },
    { helper: "harness", behavior: "reject auth", error: "synthetic auth rejection" },
    { helper: "harness", behavior: "transport error", error: "invalid opcode 3" },
    { helper: "harness", behavior: "hello then transport error", error: "invalid opcode 3" },
  ] as const)("$helper joins acquisition after $behavior", async ({ helper, behavior, error }) => {
    await runAcquisitionCase({ label: "auth-adapter-acquisition" }, async (_state, owner) => {
      await withAcquisitionPeer(
        behavior,
        async (peer) => {
          const { openWs, openTailscaleWs } = await import("./server.auth.test-helpers.js");
          const { startGatewayServerHarness } = await import("./server.e2e-ws-harness.js");
          owner.signal.throwIfAborted();
          let harness: Awaited<ReturnType<typeof startGatewayServerHarness>> | undefined;
          let acquisition: Promise<unknown> | undefined;
          await withAcquisitionCleanup(
            async () => {
              if (helper === "harness") {
                mockPeerGateway(peer);
                harness = await owner.track(startGatewayServerHarness());
              }
              owner.signal.throwIfAborted();
              const acquire = () => {
                acquisition = owner.track(
                  helper === "auth open"
                    ? openWs(peer.port)
                    : helper === "Tailscale"
                      ? openTailscaleWs({ host: "127.0.0.1", port: peer.port })
                      : harness!.openClient({
                          token: "fixture-token",
                          device: null,
                          prePairDevice: false,
                        }),
                );
                return acquisition;
              };
              const verifyFailure = (failure: unknown) => {
                expect(failure).toBeInstanceOf(Error);
                expect(failure).toMatchObject({ message: expect.stringContaining(error) });
                if (behavior.includes("transport error")) {
                  expect(peer.errors[0]).toMatchObject({ code: "WS_ERR_INVALID_OPCODE" });
                  expect(failure).toBe(peer.errors[0]);
                }
                expect(peer.unownedErrors).toEqual([]);
                expect(peer.clients).toHaveLength(1);
                expect(peer.clients[0]!.readyState).toBe(WebSocket.CLOSED);
                expect(peer.closed.has(peer.clients[0]!)).toBe(true);
                expect(peer.clients[0]!.listenerCount("open")).toBe(0);
                expect(peer.isListening()).toBe(true);
              };
              if (behavior === "hold upgrade") {
                await verifyAcquisitionTimeout(peer, 10_000, owner.signal, acquire, verifyFailure);
                expect(peer.receivedUpgrade()).toBe(true);
              } else {
                verifyFailure(
                  await acquire().then(
                    () => undefined,
                    (reason: unknown) => reason,
                  ),
                );
              }
            },
            async () => {
              await Promise.all(peer.clients.map(closeGatewayTestWebSocket));
              await Promise.allSettled([acquisition]);
              await harness?.close();
            },
          );
        },
        owner,
      );
    });
  });

  it("auth opener preserves headers and an unauthenticated challenge nonce", async () => {
    await runAcquisitionCase({ label: "auth-open-options" }, async (_state, owner) => {
      await withAcquisitionPeer(
        "reply",
        async (peer) => {
          const { openWs } = await import("./server.auth.test-helpers.js");
          const { getTrackedConnectChallengeNonce } = await import("./test-helpers.server.js");
          owner.signal.throwIfAborted();
          const ws = await owner.track(
            openWs(peer.port, {
              origin: "https://fixture.example",
              "x-acquisition-test": "auth-open",
            }),
          );
          await withAcquisitionCleanup(
            async () => {
              expect(ws).toBe(peer.clients[0]);
              expect(ws.readyState).toBe(WebSocket.OPEN);
              await vi.waitFor(() =>
                expect(getTrackedConnectChallengeNonce(ws)).toBe("test-nonce"),
              );
              expect(peer.requests).toEqual([]);
              expect(peer.upgradeHeaders).toHaveLength(1);
              expect(peer.upgradeHeaders[0]).toMatchObject({
                host: `127.0.0.1:${peer.port}`,
                origin: "https://fixture.example",
                "x-acquisition-test": "auth-open",
              });
              expect(peer.isListening()).toBe(true);
            },
            async () => {
              await closeGatewayTestWebSocket(ws);
            },
          );
        },
        owner,
      );
    });
  });

  it.each(["defaults", "overrides"] as const)(
    "Tailscale opener preserves %s before authentication",
    async (mode) => {
      await runAcquisitionCase({ label: "tailscale-open-options" }, async (_state, owner) => {
        await withAcquisitionPeer(
          "reply",
          async (peer) => {
            const { openTailscaleWs } = await import("./server.auth.test-helpers.js");
            const { getTrackedConnectChallengeNonce } = await import("./test-helpers.server.js");
            owner.signal.throwIfAborted();
            const ws = await owner.track(
              openTailscaleWs(
                { host: "127.0.0.1", port: peer.port },
                mode === "overrides"
                  ? {
                      "x-forwarded-for": "198.51.100.7",
                      "x-forwarded-proto": "http",
                      "x-forwarded-host": "proxy.example",
                      "tailscale-user-login": "fixture-operator",
                      "tailscale-user-name": "Fixture Operator",
                      origin: "https://fixture.example",
                      "x-acquisition-test": "tailscale",
                    }
                  : undefined,
              ),
            );
            await withAcquisitionCleanup(
              async () => {
                expect(ws).toBe(peer.clients[0]);
                expect(ws.readyState).toBe(WebSocket.OPEN);
                await vi.waitFor(() =>
                  expect(getTrackedConnectChallengeNonce(ws)).toBe("test-nonce"),
                );
                expect(peer.requests).toEqual([]);
                expect(peer.upgradeHeaders).toHaveLength(1);
                expect(peer.upgradeHeaders[0]).toMatchObject(
                  mode === "defaults"
                    ? {
                        host: `127.0.0.1:${peer.port}`,
                        "x-forwarded-for": "100.64.0.1",
                        "x-forwarded-proto": "https",
                        "x-forwarded-host": "gateway.tailnet.ts.net",
                        "tailscale-user-login": "peter",
                        "tailscale-user-name": "Peter",
                      }
                    : {
                        host: `127.0.0.1:${peer.port}`,
                        "x-forwarded-for": "198.51.100.7",
                        "x-forwarded-proto": "http",
                        "x-forwarded-host": "proxy.example",
                        "tailscale-user-login": "fixture-operator",
                        "tailscale-user-name": "Fixture Operator",
                        origin: "https://fixture.example",
                        "x-acquisition-test": "tailscale",
                      },
                );
                expect(peer.isListening()).toBe(true);
              },
              async () => {
                await closeGatewayTestWebSocket(ws);
              },
            );
          },
          owner,
        );
      });
    },
  );

  it("harness preserves literal connect options and returns the authenticated hello", async () => {
    await runAcquisitionCase({ label: "harness-connect-options" }, async (_state, owner) => {
      await withAcquisitionPeer(
        "reply",
        async (peer) => {
          const { startGatewayServerHarness } = await import("./server.e2e-ws-harness.js");
          const { getTrackedConnectChallengeNonce } = await import("./test-helpers.server.js");
          owner.signal.throwIfAborted();
          mockPeerGateway(peer);
          const harness = await owner.track(startGatewayServerHarness());
          await withAcquisitionCleanup(
            async () => {
              owner.signal.throwIfAborted();
              const { ws, hello } = await owner.track(
                harness.openClient({
                  browserOrigin: "https://fixture.example",
                  skipDefaultAuth: true,
                  token: "fixture-token",
                  password: "fixture-password",
                  minProtocol: 3,
                  maxProtocol: 4,
                  client: {
                    id: "fixture-client",
                    version: "fixture-version",
                    platform: "fixture-platform",
                    mode: "test",
                  },
                  role: "operator",
                  scopes: ["operator.read"],
                  caps: ["fixture-cap"],
                  commands: ["fixture.command"],
                  permissions: { "fixture.permission": true },
                  device: null,
                  prePairDevice: false,
                  traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
                }),
              );
              await withAcquisitionCleanup(
                async () => {
                  expect(ws).toBe(peer.clients[0]);
                  expect(ws.readyState).toBe(WebSocket.OPEN);
                  await vi.waitFor(() =>
                    expect(getTrackedConnectChallengeNonce(ws)).toBe("test-nonce"),
                  );
                  expect(peer.upgradeHeaders).toHaveLength(1);
                  expect(peer.upgradeHeaders[0]).toMatchObject({
                    origin: "https://fixture.example",
                  });
                  expect(peer.requests).toStrictEqual([
                    {
                      type: "req",
                      id: expect.any(String),
                      method: "connect",
                      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
                      params: {
                        minProtocol: 3,
                        maxProtocol: 4,
                        client: {
                          id: "fixture-client",
                          version: "fixture-version",
                          platform: "fixture-platform",
                          mode: "test",
                        },
                        role: "operator",
                        scopes: ["operator.read"],
                        caps: ["fixture-cap"],
                        commands: ["fixture.command"],
                        permissions: { "fixture.permission": true },
                        auth: { token: "fixture-token", password: "fixture-password" },
                      },
                    },
                  ]);
                  expect(hello).toStrictEqual({
                    type: "hello-ok",
                    protocol: 4,
                    server: { version: "test", connId: "conn-test" },
                    features: { methods: [], events: ["connect.challenge"] },
                    snapshot: {},
                    policy: {
                      maxPayload: 1000000,
                      maxBufferedBytes: 1000000,
                      tickIntervalMs: 60000,
                    },
                  });
                  expect(peer.isListening()).toBe(true);
                },
                async () => {
                  await closeGatewayTestWebSocket(ws);
                },
              );
            },
            async () => {
              // Client closure precedes the borrowed server's native disposal.
              await Promise.all(peer.clients.map(closeGatewayTestWebSocket));
              await harness.close();
            },
          );
        },
        owner,
      );
    });
  });

  it("harness preserves the explicit 37 ms response deadline", async () => {
    await runAcquisitionCase({ label: "harness-response-deadline" }, async (_state, owner) => {
      await withAcquisitionPeer(
        "no response",
        async (peer) => {
          const { startGatewayServerHarness } = await import("./server.e2e-ws-harness.js");
          owner.signal.throwIfAborted();
          mockPeerGateway(peer);
          const harness = await owner.track(startGatewayServerHarness());
          await withAcquisitionCleanup(
            async () => {
              owner.signal.throwIfAborted();
              await verifyAcquisitionTimeout(
                peer,
                37,
                owner.signal,
                () =>
                  owner.track(
                    harness.openClient({
                      token: "fixture-token",
                      device: null,
                      prePairDevice: false,
                      timeoutMs: 37,
                    }),
                  ),
                (failure) => {
                  expect(failure).toBeInstanceOf(Error);
                  expect(failure).toMatchObject({ message: "timeout" });
                  expect(peer.requests).toHaveLength(1);
                  expect(peer.requests[0]).toMatchObject({
                    method: "connect",
                    params: { auth: { token: "fixture-token" } },
                  });
                  expect(peer.clients).toHaveLength(1);
                  expect(peer.clients[0]!.readyState).toBe(WebSocket.CLOSED);
                  expect(peer.closed.has(peer.clients[0]!)).toBe(true);
                  expect(peer.unownedErrors).toEqual([]);
                  expect(peer.isListening()).toBe(true);
                },
                "response",
              );
            },
            async () => {
              await Promise.all(peer.clients.map(closeGatewayTestWebSocket));
              await harness.close();
            },
          );
        },
        owner,
      );
    });
  });
}
