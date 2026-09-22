import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { type EventEmitter, once } from "node:events";
import {
  type ClientRequest,
  createServer,
  IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startQaGatewayRpcProxy } from "./fixtures/qa-gateway-rpc-proxy.mjs";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "./helpers/gateway-websocket.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

type Proxy = Awaited<ReturnType<typeof startQaGatewayRpcProxy>>;

async function fixtureControl(proxy: Proxy, action: string, method?: string) {
  const response = await fetch(proxy.controlUrl, {
    method: "POST",
    headers: { "x-qa-fixture-token": "proxy-control-fixture" },
    body: JSON.stringify({ action, method }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ReturnType<Proxy["snapshot"]>;
}

async function expectFixtureControlRejected(proxy: Proxy, action: string, method?: string) {
  const response = await fetch(proxy.controlUrl, {
    method: "POST",
    headers: { "x-qa-fixture-token": "proxy-control-fixture" },
    body: JSON.stringify({ action, method }),
  });
  const body = await response.text();
  expect(response.status).toBe(500);
  expect(body).toBe("fixture control failed");
}

async function withProxy(
  holdUpgrade: boolean,
  body: (fixture: {
    proxy: Proxy;
    front: WebSocket;
    upstream: Promise<WebSocket>;
    upgrade: Promise<Duplex>;
    server: ReturnType<typeof createServer>;
    backendConnections: () => number;
    reconnect: () => Promise<{ front: WebSocket; upstream: Promise<WebSocket> }>;
  }) => Promise<void>,
  captureReadiness = false,
  rejectUpgrade = false,
  mediaPaths: ReadonlySet<string> = new Set(),
) {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const peers = new Set<WebSocket>();
  const backend = new WebSocketServer({ noServer: true });
  const upgrade = createDeferred<Duplex>();
  const upstream = createDeferred<WebSocket>();
  let nextUpstream = upstream;
  let backendConnections = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    upgrade.resolve(socket);
    if (rejectUpgrade) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nX-Fixture-Private: private-header-marker\r\nContent-Length: 19\r\n\r\nprivate-body-marker",
      );
    } else if (holdUpgrade) {
      socket.on("end", () => socket.end());
      socket.resume();
    } else {
      backend.handleUpgrade(request, socket, head, (ws) => {
        backendConnections += 1;
        peers.add(ws);
        ws.once("close", () => peers.delete(ws));
        nextUpstream.resolve(ws);
      });
    }
  });
  let proxy: Proxy | undefined;
  let front: WebSocket | undefined;
  await runQaGatewayFixture(
    async () => {
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      proxy = await startQaGatewayRpcProxy({
        backendPort: (server.address() as AddressInfo).port,
        repoRoot: fileURLToPath(new URL("../", import.meta.url)),
        upstreamHeaders: { "x-qa-private": "private-header-marker" },
        captureReadiness,
        mediaPaths,
        token: "proxy-control-fixture",
      });
      front = new WebSocket(proxy.url);
      await acquireGatewayTestWebSocket(front, 5000);
      const proxyURL = proxy.url;
      await body({
        proxy,
        front,
        upstream: upstream.promise,
        upgrade: upgrade.promise,
        server,
        backendConnections: () => backendConnections,
        reconnect: async () => {
          if (front) {
            await closeGatewayTestWebSocket(front);
          }
          nextUpstream = createDeferred<WebSocket>();
          front = new WebSocket(proxyURL);
          await acquireGatewayTestWebSocket(front, 5000);
          return { front, upstream: nextUpstream.promise };
        },
      });
    },
    async () => {
      if (front) {
        await closeGatewayTestWebSocket(front);
      }
    },
    async () => {
      if (proxy) {
        await proxy.stop();
      }
    },
    async () => {
      await Promise.all([...peers].map(closeGatewayTestWebSocket));
      await Promise.all(
        [...sockets].map(async (socket) => {
          const closed = once(socket, "close");
          socket.destroy();
          await closed;
        }),
      );
      await new Promise<void>((resolve) => {
        backend.close(() => resolve());
      });
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
}

function expectTraceOrder(trace: ReturnType<Proxy["snapshot"]>["firstConnection"], tags: string[]) {
  let previous = -1;
  for (const tag of tags) {
    const index = trace.findIndex((entry) => entry.tag === tag);
    expect(index, tag).toBeGreaterThan(previous);
    previous = index;
  }
}

function holdCloseNotification(
  owner: EventEmitter,
  order: string[],
  tag = "outbound-close",
) {
  const entered = createDeferred<void>();
  const delivered = createDeferred<void>();
  const originalEmit = owner.emit;
  let released = false;
  let resume: (() => boolean) | undefined;
  // Termination and socket closure still run. Hold only this owner's final
  // notification so listener/server shutdown cannot stand in for its lifetime.
  const emit = vi.spyOn(owner, "emit").mockImplementation((event, ...args) => {
    if (event !== "close") {
      return Reflect.apply(originalEmit, owner, [event, ...args]);
    }
    const notify = () => {
      const result = Reflect.apply(originalEmit, owner, [event, ...args]);
      order.push(tag);
      delivered.resolve();
      return result;
    };
    entered.resolve();
    if (released) {
      return notify();
    }
    resume = notify;
    return owner.listenerCount("close") > 0;
  });
  return {
    entered: entered.promise,
    delivered: delivered.promise,
    release() {
      released = true;
      const notify = resume;
      resume = undefined;
      notify?.();
    },
    restore: () => emit.mockRestore(),
  };
}

function observeProxyOutboundClose(server: Server) {
  const backendURL = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const closed = createDeferred<void>();
  let outbound: WebSocket | undefined;
  const onClose = () => closed.resolve();
  const originalTerminate = WebSocket.prototype.terminate;
  const terminate = vi
    .spyOn(WebSocket.prototype, "terminate")
    .mockImplementation(function (this: WebSocket) {
      if (!outbound && this.url === backendURL) {
        outbound = this;
        this.once("close", onClose);
      }
      originalTerminate.call(this);
    });
  return {
    closed: closed.promise,
    dispose() {
      terminate.mockRestore();
      outbound?.off("close", onClose);
    },
  };
}

function observeProxyServerClose(proxyURL: string) {
  const port = Number(new URL(proxyURL).port);
  const closed = createDeferred<void>();
  let observed: Server | undefined;
  const onClose = () => closed.resolve();
  const onRequest = (message: unknown) => {
    const { server } = message as { server: Server };
    const address = server.address();
    if (!observed && address && typeof address !== "string" && address.port === port) {
      observed = server;
      server.once("close", onClose);
    }
  };
  subscribe("http.server.request.start", onRequest);
  return {
    closed: closed.promise,
    dispose() {
      unsubscribe("http.server.request.start", onRequest);
      observed?.off("close", onClose);
    },
  };
}

async function closeBackendServer(server: Server) {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("QA Gateway proxy first-connection diagnostics", () => {
  it("joins an ordinary outbound HTTP close after the listener has closed", async () => {
    const path = "/ordinary-stop-without-headers";
    const received = createDeferred<ServerResponse>();
    const captured = createDeferred<ClientRequest>();
    const order: string[] = [];
    const sockets = new Set<Duplex>();
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === path) {
        received.resolve(response);
      }
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    let backendPort: number;
    let proxy: Proxy | undefined;
    let observer: ReturnType<typeof observeProxyServerClose> | undefined;
    let gate: ReturnType<typeof holdCloseNotification> | undefined;
    let stopped: Promise<void> | undefined;
    let backendClosing: Promise<void> | undefined;
    const closeBackend = () => (backendClosing ??= closeBackendServer(server));
    let response: Promise<unknown> | undefined;
    const abort = new AbortController();
    const onRequest = (message: unknown) => {
      const { request } = message as { request: ClientRequest };
      if (
        !gate &&
        request.method === "GET" &&
        request.path === path &&
        request.getHeader("host") === `127.0.0.1:${backendPort}`
      ) {
        gate = holdCloseNotification(request, order);
        captured.resolve(request);
      }
    };
    subscribe("http.client.request.start", onRequest);
    await runQaGatewayFixture(
      async () => {
        const listening = once(server, "listening");
        server.listen(0, "127.0.0.1");
        await listening;
        backendPort = (server.address() as AddressInfo).port;
        proxy = await startQaGatewayRpcProxy({
          backendPort,
          repoRoot: fileURLToPath(new URL("../", import.meta.url)),
        });
        observer = observeProxyServerClose(proxy.url);
        response = fetch(new URL(path, proxy.controlUrl), { signal: abort.signal })
          .then((value) => value.arrayBuffer())
          .catch(() => undefined);
        const outbound = await withTestTimeout(
          captured.promise,
          5000,
          "outbound HTTP not captured",
        );
        expect(
          (await withTestTimeout(received.promise, 5000, "backend did not receive ordinary GET"))
            .headersSent,
        ).toBe(false);
        expect(proxy.snapshot().firstConnection).toEqual([]);
        expect(proxy.snapshot().media).toEqual({
          requests: 0,
          matched: 0,
          completed: 0,
          succeeded: 0,
        });
        assert(gate);
        stopped = proxy.stop();
        void stopped.then(
          () => order.push("stop"),
          () => order.push("stop-error"),
        );
        expect(proxy.stop()).toBe(stopped);
        await withTestTimeout(
          Promise.all([gate.entered, observer.closed]),
          5000,
          "HTTP socket and proxy listener did not close",
        );
        expect(outbound.destroyed).toBe(true);
        expect(outbound.socket?.destroyed).toBe(true);
        // Join a real backend terminal after the proxy's other terminals. This
        // leaves the selected notification held without a sleep-based assertion.
        await withTestTimeout(closeBackend(), 5000, "backend did not close");
        expect(order).toEqual([]);
        gate.release();
        await gate.delivered;
        await stopped;
        expect(order).toEqual(["outbound-close", "stop"]);
        expect(proxy.stop()).toBe(stopped);
      },
      () => {
        unsubscribe("http.client.request.start", onRequest);
        gate?.release();
        abort.abort();
      },
      async () => {
        stopped ??= proxy?.stop();
        await response;
        await stopped;
        if (gate) {
          await gate.delivered;
        }
      },
      () => {
        gate?.restore();
        observer?.dispose();
      },
      async () => {
        const closing = closeBackend();
        await Promise.all(
          [...sockets].map(async (socket) => {
            const closed = new Promise<void>((resolve) => socket.once("close", resolve));
            socket.destroy();
            await closed;
          }),
        );
        await closing;
      },
    );
  });

  it.each([false, true])(
    "joins the outbound WebSocket close with frontend already closed=%s",
    async (frontClosedFirst) => {
      await withProxy(false, async ({ proxy, front, upstream, server }) => {
        const backend = await upstream;
        const backendClosed = new Promise<void>((resolve) => backend.once("close", resolve));
        const backendURL = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
        const captured = createDeferred<WebSocket>();
        const order: string[] = [];
        let gate: ReturnType<typeof holdCloseNotification> | undefined;
        let terminatingState: number | undefined;
        let stopped: Promise<void> | undefined;
        let backendClosing: Promise<void> | undefined;
        const closeBackend = () => (backendClosing ??= closeBackendServer(server));
        const originalTerminate = WebSocket.prototype.terminate;
        const terminate = vi
          .spyOn(WebSocket.prototype, "terminate")
          .mockImplementation(function (this: WebSocket) {
            if (!gate && this.url === backendURL) {
              terminatingState = this.readyState;
              gate = holdCloseNotification(this, order);
              captured.resolve(this);
            }
            originalTerminate.call(this);
          });
        const observer = observeProxyServerClose(proxy.url);
        await runQaGatewayFixture(
          async () => {
            await fixtureControl(proxy, "snapshot");
            const marker = JSON.stringify({ type: "event", event: "fixture-ready" });
            const received = once(backend, "message");
            front.send(marker);
            expect(
              (
                await withTestTimeout(received, 5000, "proxy did not forward the ready frame")
              )[0].toString(),
            ).toBe(marker);
            if (frontClosedFirst) {
              await closeGatewayTestWebSocket(front);
              await withTestTimeout(captured.promise, 5000, "outbound WebSocket not captured");
              assert(gate);
              await withTestTimeout(gate.entered, 5000, "outbound close was not reached");
              expect(
                proxy.snapshot().firstConnection.some(({ tag }) => tag === "front-close"),
              ).toBe(true);
            }
            stopped = proxy.stop();
            void stopped.then(
              () => order.push("stop"),
              () => order.push("stop-error"),
            );
            expect(proxy.stop()).toBe(stopped);
            const outbound = await withTestTimeout(
              captured.promise,
              5000,
              "outbound WebSocket not captured",
            );
            assert(gate);
            expect(terminatingState).toBe(WebSocket.OPEN);
            await withTestTimeout(
              Promise.all([gate.entered, observer.closed, backendClosed]),
              5000,
              "WebSocket sockets and proxy listener did not close",
            );
            await closeGatewayTestWebSocket(front);
            expect(outbound.readyState).toBe(WebSocket.CLOSED);
            expect(backend.readyState).toBe(WebSocket.CLOSED);
            await withTestTimeout(closeBackend(), 5000, "backend listener did not close");
            expect(order).toEqual([]);
            gate.release();
            await gate.delivered;
            await stopped;
            expect(order).toEqual(["outbound-close", "stop"]);
            expect(proxy.stop()).toBe(stopped);
          },
          () => {
            terminate.mockRestore();
            gate?.release();
          },
          () => closeGatewayTestWebSocket(front),
          async () => {
            stopped ??= proxy.stop();
            await stopped;
            if (gate) {
              await gate.delivered;
            }
          },
          () => {
            gate?.restore();
            observer.dispose();
          },
          () => closeBackend(),
        );
      });
    },
  );

  it.each([false, true])(
    "closes admission while an aborted media iterator is still settling (overlap=%s)",
    async (overlap) => {
      const firstChunk = createDeferred<void>();
      const abortEntered = createDeferred<void>();
      const releaseAbort = createDeferred<void>();
      const originalIterator = IncomingMessage.prototype[Symbol.asyncIterator];
      const iteratorSpy = vi
        .spyOn(IncomingMessage.prototype, Symbol.asyncIterator)
        .mockImplementation(function (this: IncomingMessage) {
          const iterator = originalIterator.call(this);
          if (this.headers["x-qa-stop-media"] !== "held") {
            return iterator;
          }
          const next = iterator.next.bind(iterator);
          iterator.next = async () => {
            try {
              const result = await next();
              if (!result.done) {
                firstChunk.resolve();
              }
              return result;
            } catch (error) {
              abortEntered.resolve();
              await releaseAbort.promise;
              throw error;
            }
          };
          return iterator;
        });
      await runQaGatewayFixture(
        () =>
          withProxy(
            false,
            async ({ proxy, upstream, server, backendConnections }) => {
              await upstream;
              server.on("request", (request, response) => {
                if (request.url === "/ordinary-media") {
                  response.writeHead(200).end("ordinary media");
                  return;
                }
                response.writeHead(200, { "x-qa-stop-media": "held" });
                response.write("partial media");
              });
              await fixtureControl(proxy, "hold-response", "media.get");
              const media = fetch(new URL("/held-media", proxy.controlUrl))
                .then((response) => response.arrayBuffer())
                .catch(() => undefined);
              let attempted: WebSocket | undefined;
              let stop: Promise<void> | undefined;
              const ordinaryAbort = new AbortController();
              let ordinary: Promise<string> | undefined;
              await runQaGatewayFixture(
                async () => {
                  await withTestTimeout(
                    firstChunk.promise,
                    5000,
                    "media iterator did not receive a chunk",
                  );
                  if (overlap) {
                    ordinary = fetch(new URL("/ordinary-media", proxy.controlUrl), {
                      signal: ordinaryAbort.signal,
                    }).then((response) => response.text());
                    expect(
                      await withTestTimeout(ordinary, 5000, "overlapping media was held"),
                    ).toBe("ordinary media");
                  }
                  const connections = backendConnections();
                  stop = proxy.stop();
                  expect(proxy.stop()).toBe(stop);
                  let stopped = false;
                  void stop.then(
                    () => {
                      stopped = true;
                    },
                    () => {
                      stopped = true;
                    },
                  );
                  await withTestTimeout(
                    abortEntered.promise,
                    5000,
                    "media abort did not reach the iterator",
                  );
                  expect(stopped).toBe(false);
                  attempted = new WebSocket(proxy.url);
                  await expect(acquireGatewayTestWebSocket(attempted, 5000)).rejects.toMatchObject({
                    code: "ECONNREFUSED",
                  });
                  expect(backendConnections()).toBe(connections);
                  expect(stopped).toBe(false);
                  releaseAbort.resolve();
                  await stop;
                  expect(proxy.stop()).toBe(stop);
                },
                () => {
                  releaseAbort.resolve();
                  ordinaryAbort.abort();
                  stop ??= proxy.stop();
                  void stop.catch(() => undefined);
                },
                async () => {
                  if (attempted) {
                    await closeGatewayTestWebSocket(attempted);
                  }
                },
                async () => {
                  await Promise.allSettled([media, ordinary]);
                  await stop;
                },
              );
            },
            false,
            false,
            new Set(["/held-media", "/ordinary-media"]),
          ),
        () => {
          releaseAbort.resolve();
          iteratorSpy.mockRestore();
        },
      );
    },
  );

  it("relays challenge and connect bytes unchanged", async () => {
    await withProxy(false, async ({ proxy, front, upstream }) => {
      const back = await upstream;
      const challenge = Buffer.from(
        '{"type":"event", "event":"connect.challenge","payload":{"nonce":"private-nonce-marker"}}',
      );
      const challengeReceived = once(front, "message");
      back.send(challenge);
      expect((await challengeReceived)[0]).toEqual(challenge);

      const connect = Buffer.from(
        '{"type":"req", "id":"fixture","method":"connect","params":{"private":"private-payload-marker"}}',
      );
      const connectReceived = once(back, "message");
      front.send(connect);
      expect((await connectReceived)[0]).toEqual(connect);
      expect(proxy.snapshot().events).toContainEqual(
        expect.objectContaining({ kind: "connect-request", connection: 1 }),
      );
      const trace = proxy.snapshot().firstConnection;
      expectTraceOrder(trace, [
        "upstream-create-start",
        "upstream-create-return",
        "upstream-upgrade",
        "upstream-open",
      ]);
      expect(JSON.stringify(trace)).not.toContain("private-");
      expect(proxy.readinessSnapshot()).toEqual({ truncated: false, connections: [] });
    });
  });

  it.each([
    { frontClosedFirst: false, captureReadiness: false },
    { frontClosedFirst: true, captureReadiness: false },
    { frontClosedFirst: false, captureReadiness: true },
    { frontClosedFirst: true, captureReadiness: true },
  ])(
    "joins a CONNECTING request with frontend already closed=$frontClosedFirst, readiness=$captureReadiness",
    async ({ frontClosedFirst, captureReadiness }) => {
      // The proxy starts its upgrade before withProxy enters the body. Observe
      // public request starts, then select the exact backend authority below.
      const upgrades: ClientRequest[] = [];
      const onRequest = (message: unknown) => {
        const { request } = message as { request: ClientRequest };
        if (
          request.method === "GET" &&
          request.path === "/" &&
          request.getHeader("upgrade") === "websocket"
        ) {
          upgrades.push(request);
        }
      };
      subscribe("http.client.request.start", onRequest);
      await runQaGatewayFixture(
        () =>
          withProxy(
            true,
            async ({ proxy, front, upgrade, server }) => {
              const socket = await upgrade;
              const backendClosed = new Promise<void>((resolve) => socket.once("close", resolve));
              const authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
              const requests = upgrades.filter(
                (request) => request.getHeader("host") === authority,
              );
              expect(requests).toHaveLength(1);
              const outbound = requests[0];
              assert(outbound);
              unsubscribe("http.client.request.start", onRequest);
              expect(outbound.destroyed).toBe(false);
              const order: string[] = [];
              const gate = holdCloseNotification(outbound, order);
              const observer = observeProxyServerClose(proxy.url);
              const backClosed = createDeferred<void>();
              let back: WebSocket | undefined;
              let terminatingState: number | undefined;
              let stopped: Promise<void> | undefined;
              let backendClosing: Promise<void> | undefined;
              const closeBackend = () => (backendClosing ??= closeBackendServer(server));
              const originalTerminate = WebSocket.prototype.terminate;
              const terminate = vi
                .spyOn(WebSocket.prototype, "terminate")
                .mockImplementation(function (this: WebSocket) {
                  if (!back && this.url === `ws://${authority}/`) {
                    back = this;
                    terminatingState = this.readyState;
                    this.once("close", () => backClosed.resolve());
                  }
                  originalTerminate.call(this);
                });
              await runQaGatewayFixture(
                async () => {
                  await fixtureControl(proxy, "snapshot");
                  if (frontClosedFirst) {
                    await closeGatewayTestWebSocket(front);
                    await withTestTimeout(
                      Promise.all([backClosed.promise, gate.entered]),
                      5000,
                      "CONNECTING WebSocket did not close before its request notification",
                    );
                    expect(back?.readyState).toBe(WebSocket.CLOSED);
                    expect(
                      proxy.snapshot().firstConnection.some(({ tag }) => tag === "front-close"),
                    ).toBe(true);
                  }
                  stopped = proxy.stop();
                  void stopped.then(
                    () => order.push("stop"),
                    () => order.push("stop-error"),
                  );
                  expect(proxy.stop()).toBe(stopped);
                  await withTestTimeout(
                    Promise.all([gate.entered, backClosed.promise, observer.closed, backendClosed]),
                    5000,
                    "CONNECTING sockets and proxy listener did not close",
                  );
                  await closeGatewayTestWebSocket(front);
                  expect(terminatingState).toBe(WebSocket.CONNECTING);
                  expect(back?.readyState).toBe(WebSocket.CLOSED);
                  expect(outbound.destroyed).toBe(true);
                  expect(outbound.socket?.destroyed).toBe(true);
                  // Start this real terminal only after the proxy terminal; a
                  // simultaneous barrier could run before an underjoined stop.
                  await withTestTimeout(closeBackend(), 5000, "backend listener did not close");
                  expect(order).toEqual([]);
                  gate.release();
                  await gate.delivered;
                  await stopped;
                  expect(order).toEqual(["outbound-close", "stop"]);

                  const localTermination = frontClosedFirst ? "front-close" : "stop";
                  const trace = proxy.snapshot().firstConnection;
                  expect(trace).toEqual(
                    expect.arrayContaining([
                      expect.objectContaining({
                        tag: "upstream-terminate",
                        state: "CONNECTING",
                        localTermination,
                      }),
                      expect.objectContaining({
                        tag: "upstream-error",
                        localTermination,
                        errorCode: "none",
                      }),
                    ]),
                  );
                  expectTraceOrder(trace, [
                    "upstream-create-start",
                    "upstream-create-return",
                    ...(frontClosedFirst ? ["front-close"] : []),
                    "upstream-terminate",
                    "upstream-error",
                  ]);
                  expect(trace).not.toEqual(
                    expect.arrayContaining([expect.objectContaining({ tag: "upstream-upgrade" })]),
                  );
                  expect(trace.filter(({ tag }) => tag.endsWith("-terminate"))).toHaveLength(2);
                  if (captureReadiness) {
                    expect(proxy.readinessSnapshot().connections[0]?.handshake).toMatchObject({
                      requestReadyMs: expect.any(Number),
                      requestFinishedMs: expect.any(Number),
                    });
                  } else {
                    expect(proxy.readinessSnapshot().connections).toEqual([]);
                  }
                },
                () => {
                  terminate.mockRestore();
                  gate.release();
                },
                () => closeGatewayTestWebSocket(front),
                async () => {
                  stopped ??= proxy.stop();
                  await stopped;
                  await gate.delivered;
                },
                () => {
                  gate.restore();
                  observer.dispose();
                },
                () => closeBackend(),
              );
            },
            captureReadiness,
          ),
        () => unsubscribe("http.client.request.start", onRequest),
      );
    },
  );

  it("records an independent upstream failure before local frontend termination", async () => {
    await withProxy(true, async ({ proxy, front, upgrade }) => {
      const socket = await upgrade;
      expect(front.readyState).toBe(WebSocket.OPEN);
      const frontendClosed = once(front, "close");
      const upstreamClosed = once(socket, "close");
      socket.destroy();
      await Promise.all([frontendClosed, upstreamClosed]);
      await proxy.stop();

      const trace = proxy.snapshot().firstConnection;
      expect(trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tag: "upstream-error",
            localTermination: "none",
            errorCode: "ECONNRESET",
          }),
          expect.objectContaining({
            tag: "front-terminate",
            state: "OPEN",
            localTermination: "upstream-error",
          }),
        ]),
      );
      expectTraceOrder(trace, ["upstream-create-return", "upstream-error", "front-terminate"]);
      expect(trace.filter(({ tag }) => tag.endsWith("-terminate"))).toHaveLength(2);
      expect(trace.length).toBeLessThanOrEqual(16);
      for (const entry of trace) {
        expect(Object.keys(entry)).toEqual(expect.arrayContaining(["elapsedMs", "tag"]));
        expect(
          Object.keys(entry).every((key) =>
            ["tag", "elapsedMs", "state", "localTermination", "errorCode"].includes(key),
          ),
        ).toBe(true);
      }
      const evidence = JSON.stringify(trace);
      expect(evidence).not.toMatch(/private-|127\.0\.0\.1|socket hang up|Error:/);
    });
  });
});

describe("QA Gateway proxy readiness diagnostics", () => {
  async function exchange(
    front: WebSocket,
    back: WebSocket,
    ordinal: number,
    method: string,
    ok: boolean,
  ) {
    const id = `private-request-${ordinal}`;
    const request = Buffer.from(
      JSON.stringify({
        type: "req",
        id,
        method,
        expectedProfileId: "private-profile",
        params: { token: "private-token" },
      }),
    );
    const received = once(back, "message");
    front.send(request);
    expect((await received)[0]).toEqual(request);
    const response = Buffer.from(
      JSON.stringify({
        type: "res",
        id,
        ok,
        payload: { token: "private-response" },
        error: {
          code: "private-code",
          message: "private-message",
          details: { url: "https://private.example" },
        },
      }),
    );
    const returned = once(front, "message");
    back.send(response);
    expect((await returned)[0]).toEqual(response);
  }

  it("freezes private history request owners without changing bytes or exposing IDs", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, reconnect }) => {
        const back = await upstream;
        await exchange(front, back, 1, "connect", true);
        await exchange(front, back, 2, "chat.history", true);
        const frozen = proxy.captureHistoryRequestMatcher();
        expect(frozen("private-request-2")).toEqual({
          status: "matched",
          connection: 1,
          request: 2,
        });
        expect(frozen("absent")).toEqual({ status: "unknown" });
        expect(frozen(undefined)).toEqual({ status: "unknown" });
        expect(frozen("x".repeat(129))).toEqual({ status: "unknown" });
        // A same-connection reuse and later reconnection must not mutate the old snapshot.
        await exchange(front, back, 2, "chat.history", true);
        expect(proxy.captureHistoryRequestMatcher()("private-request-2")).toEqual({
          status: "unknown",
        });
        const second = await reconnect();
        await exchange(second.front, await second.upstream, 3, "chat.history", true);
        expect(proxy.captureHistoryRequestMatcher()("private-request-3")).toEqual({
          status: "matched",
          connection: 2,
          request: 1,
        });
        expect(frozen("private-request-3")).toEqual({ status: "unknown" });
        expect(frozen("private-request-2")).toEqual({
          status: "matched",
          connection: 1,
          request: 2,
        });
        const third = await reconnect();
        await exchange(third.front, await third.upstream, 3, "chat.history", true);
        expect(proxy.captureHistoryRequestMatcher()("private-request-3")).toEqual({
          status: "unknown",
        });
        expect(JSON.stringify(proxy.readinessSnapshot())).not.toMatch(
          /private|requestId|127\.0\.0\.1|token|payload/,
        );
      },
      true,
    );
  });

  it("keeps malformed or missing history IDs unknown while forwarding the original bytes", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream }) => {
        const back = await upstream;
        for (const id of [undefined, 42, "", "x".repeat(129)]) {
          const raw = Buffer.from(JSON.stringify({ type: "req", id, method: "chat.history" }));
          const received = once(back, "message");
          front.send(raw);
          expect((await received)[0]).toEqual(raw);
          expect(proxy.captureHistoryRequestMatcher()(id)).toEqual({ status: "unknown" });
        }
        expect(JSON.stringify(proxy.readinessSnapshot())).not.toContain("x".repeat(129));
      },
      true,
    );
  });

  it("distinguishes a locally written upgrade request from an upstream HTTP upgrade", async () => {
    await withProxy(
      true,
      async ({ proxy, upgrade }) => {
        await upgrade;
        await expect
          .poll(() => proxy.readinessSnapshot().connections[0]?.handshake.requestFinishedMs)
          .toBeTypeOf("number");
        const connection = proxy.readinessSnapshot().connections[0];
        assert(connection);
        expect(connection.handshake).toMatchObject({
          requestReadyMs: expect.any(Number),
          socketAssigned: { elapsedMs: expect.any(Number), connecting: expect.any(Boolean) },
          tcpConnectedMs: expect.any(Number),
          requestFinishedMs: expect.any(Number),
        });
        expect(connection.handshake.httpResponse).toBeUndefined();
        expect(connection.lifecycle).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ tag: "upstream-upgrade" })]),
        );
        expect(connection.lifecycle).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ tag: "upstream-open" })]),
        );
      },
      true,
    );
  });

  it("records a non-upgrade HTTP status without suppressing the default WebSocket abort", async () => {
    await withProxy(
      false,
      async ({ proxy, front }) => {
        await expect.poll(() => front.readyState).toBe(WebSocket.CLOSED);
        await proxy.stop();
        const connection = proxy.readinessSnapshot().connections[0];
        assert(connection);
        const httpResponse = connection.handshake.httpResponse;
        assert(httpResponse);
        expect(httpResponse).toEqual({
          elapsedMs: expect.any(Number),
          statusCode: 503,
        });
        expect(connection.lifecycle).toContainEqual(
          expect.objectContaining({ tag: "upstream-error", localTermination: "none" }),
        );
        expect(connection.lifecycle).toContainEqual(
          expect.objectContaining({ tag: "upstream-close" }),
        );
        expect(connection.lifecycle).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ tag: "upstream-open" })]),
        );
        expect(JSON.stringify(connection)).not.toMatch(/private|127\.0\.0\.1|503 Service/);
        httpResponse.statusCode = 500;
        expect(proxy.readinessSnapshot().connections[0]?.handshake.httpResponse?.statusCode).toBe(
          503,
        );
      },
      true,
      true,
    );
  });

  it("retains pairing-retry requests and a pending method without private wire data", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, reconnect }) => {
        await exchange(front, await upstream, 1, "connect", false);
        const second = await reconnect();
        const back = await second.upstream;
        await exchange(second.front, back, 2, "connect", true);
        await exchange(second.front, back, 3, "users.self", true);
        const received = once(back, "message");
        second.front.send(
          JSON.stringify({ type: "req", id: "private-pending", method: "chat.history" }),
        );
        await received;
        await expect
          .poll(() => proxy.readinessSnapshot().connections[1]?.requests[1]?.frontWrite?.outcome)
          .toBe("ok");
        await closeGatewayTestWebSocket(second.front);
        await proxy.stop();
        const snapshot = proxy.readinessSnapshot();
        expect(snapshot.truncated).toBe(false);
        expect(snapshot.connections.map(({ connection }) => connection)).toEqual([1, 2]);
        const [firstConnection, secondConnection] = snapshot.connections;
        assert(firstConnection && secondConnection);
        const socketAssigned = secondConnection.handshake.socketAssigned;
        assert(socketAssigned);
        expect(firstConnection.requests[0]).toMatchObject({
          ordinal: 1,
          method: "connect",
          response: { outcome: "error", code: "other" },
          upstreamWrite: { outcome: "ok" },
          frontWrite: { outcome: "ok" },
        });
        expect(secondConnection.requests).toEqual([
          expect.objectContaining({
            ordinal: 1,
            method: "connect",
            response: expect.objectContaining({ outcome: "ok", code: "none" }),
          }),
          expect.objectContaining({
            ordinal: 2,
            method: "users.self",
            response: expect.objectContaining({ outcome: "ok", code: "none" }),
          }),
          expect.objectContaining({
            ordinal: 3,
            method: "chat.history",
            upstreamWrite: expect.objectContaining({ outcome: "ok" }),
          }),
        ]);
        expect(secondConnection.requests[2].response).toBeUndefined();
        expect(secondConnection.lifecycle).toContainEqual(
          expect.objectContaining({ tag: "front-close" }),
        );
        expect(JSON.stringify(snapshot)).not.toMatch(
          /private|127\.0\.0\.1|requestId|profileId|token|payload|https:/,
        );
        firstConnection.requests[0].response!.code = "none";
        secondConnection.lifecycle[0].elapsedMs = -1;
        socketAssigned.elapsedMs = -1;
        expect(proxy.readinessSnapshot().connections[0]?.requests[0].response?.code).toBe("other");
        expect(
          proxy.readinessSnapshot().connections[1]?.lifecycle[0].elapsedMs,
        ).toBeGreaterThanOrEqual(0);
        expect(
          proxy.readinessSnapshot().connections[1]?.handshake.socketAssigned?.elapsedMs,
        ).toBeGreaterThanOrEqual(0);
      },
      true,
    );
  });

  it("distinguishes queued requests from an upstream write attempt", async () => {
    await withProxy(
      true,
      async ({ proxy, front, upgrade }) => {
        await upgrade;
        front.send(JSON.stringify({ type: "req", id: "private-queued", method: "users.self" }));
        await expect.poll(() => proxy.readinessSnapshot().connections[0]?.requests.length).toBe(1);
        const request = proxy.readinessSnapshot().connections[0]?.requests[0];
        assert(request);
        expect(request.queued).toBe(true);
        expect(request.upstreamStartedMs).toBeUndefined();
        expect(request.upstreamWrite).toBeUndefined();
        expect(request.response).toBeUndefined();
      },
      true,
    );
  });

  it("caps connections and requests without dropping forwarded bytes or clearing saturation", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, reconnect }) => {
        let pair = { front, upstream };
        for (let connection = 1; connection <= 5; connection++) {
          const back = await pair.upstream;
          for (let request = 1; request <= 34; request++) {
            await exchange(
              pair.front,
              back,
              request,
              connection === 1 && request === 1 ? "chat.history" : "health",
              true,
            );
          }
          if (connection < 5) {
            pair = await reconnect();
          }
        }
        await closeGatewayTestWebSocket(pair.front);
        await proxy.stop();
        const snapshot = proxy.readinessSnapshot();
        expect(snapshot.truncated).toBe(true);
        expect(snapshot.connections).toHaveLength(4);
        for (const connection of snapshot.connections) {
          expect(connection.truncated).toBe(true);
          expect(connection.requests).toHaveLength(32);
          expect(connection.lifecycle.length).toBeLessThanOrEqual(16);
          expect(
            connection.requests.every(
              ({ response }: { response?: { outcome: "ok" | "error" } }) =>
                response?.outcome === "ok",
            ),
          ).toBe(true);
        }
        expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(64 * 1024);
        expect(proxy.snapshot().events).toEqual([]);
        expect(proxy.readinessSnapshot().truncated).toBe(true);
        expect(proxy.captureHistoryRequestMatcher()("private-request-1")).toEqual({
          status: "unknown",
        });
      },
      true,
    );
  });
});

describe("QA Gateway proxy held responses", () => {
  it("keeps the first media response reserved while another response completes", async () => {
    const firstChunk = createDeferred<void>();
    const firstBody = Buffer.from("first media response");
    const ordinaryBody = "ordinary media response";
    const originalIterator = IncomingMessage.prototype[Symbol.asyncIterator];
    const iteratorSpy = vi
      .spyOn(IncomingMessage.prototype, Symbol.asyncIterator)
      .mockImplementation(function (this: IncomingMessage) {
        const iterator = originalIterator.call(this);
        if (this.headers["x-qa-overlap-media"] === "first") {
          const next = iterator.next.bind(iterator);
          iterator.next = async () => {
            const result = await next();
            if (!result.done) {
              firstChunk.resolve();
            }
            return result;
          };
        }
        return iterator;
      });
    await runQaGatewayFixture(
      () =>
        withProxy(
          false,
          async ({ proxy, upstream, server }) => {
            await upstream;
            let firstResponse: ServerResponse | undefined;
            server.on("request", (request, response) => {
              if (request.url === "/first-media") {
                firstResponse = response;
                response.writeHead(200, { "x-qa-overlap-media": "first" });
                response.write(firstBody.subarray(0, 1));
              } else {
                response.writeHead(200).end(ordinaryBody);
              }
            });
            const abort = new AbortController();
            const clients: Promise<unknown>[] = [];
            const readMedia = (path: string) => {
              const reading = fetch(new URL(path, proxy.controlUrl), { signal: abort.signal }).then(
                async (response) => Buffer.from(await response.arrayBuffer()),
              );
              clients.push(reading);
              void reading.catch(() => undefined);
              return reading;
            };
            await runQaGatewayFixture(
              async () => {
                await fixtureControl(proxy, "hold-response", "media.get");
                const first = readMedia("/first-media");
                await withTestTimeout(
                  firstChunk.promise,
                  5000,
                  "first media body did not enter the collector",
                );
                const held = fixtureControl(proxy, "wait-held");
                clients.push(held);
                void held.catch(() => undefined);
                const overlapping = await fetch(proxy.controlUrl, {
                  method: "POST",
                  headers: { "x-qa-fixture-token": "proxy-control-fixture" },
                  body: JSON.stringify({ action: "hold-response", method: "media.get" }),
                  signal: abort.signal,
                });
                expect(overlapping.status).toBe(500);
                await overlapping.text();
                const ordinary = readMedia("/ordinary-media");
                expect(
                  await withTestTimeout(
                    Promise.race([
                      ordinary,
                      held.then(() => {
                        throw new Error("another response replaced the buffering media hold");
                      }),
                    ]),
                    5000,
                    "overlapping media response did not complete",
                  ),
                ).toEqual(Buffer.from(ordinaryBody));
                expect(proxy.snapshot().heldResponse).toBeUndefined();
                assert(firstResponse);
                firstResponse.end(firstBody.subarray(1));
                const expected = {
                  method: "media.get",
                  ok: true,
                  sizeBytes: firstBody.length,
                  sha256: createHash("sha256").update(firstBody).digest("hex"),
                };
                expect((await held).heldResponse).toEqual(expected);
                const released = await fixtureControl(proxy, "release-response");
                expect(await first).toEqual(firstBody);
                expect(released.events.filter(({ kind }) => kind === "response-held")).toEqual([
                  expect.objectContaining(expected),
                ]);
                expect(released.events.filter(({ kind }) => kind === "response-released")).toEqual([
                  expect.objectContaining({ ...expected, delivered: true }),
                ]);

                await fixtureControl(proxy, "hold-response", "media.get");
                const rearmed = readMedia("/ordinary-media");
                expect((await fixtureControl(proxy, "wait-held")).heldResponse).toEqual({
                  method: "media.get",
                  ok: true,
                  sizeBytes: Buffer.byteLength(ordinaryBody),
                  sha256: createHash("sha256").update(ordinaryBody).digest("hex"),
                });
                await fixtureControl(proxy, "release-response");
                expect(await rearmed).toEqual(Buffer.from(ordinaryBody));
              },
              async () => {
                if (firstResponse && !firstResponse.writableEnded && !firstResponse.destroyed) {
                  firstResponse.end();
                }
                abort.abort();
                const stopped = proxy.stop();
                await Promise.allSettled([...clients, stopped]);
                await stopped;
              },
            );
          },
          false,
          false,
          new Set(["/first-media", "/ordinary-media"]),
        ),
      () => iteratorSpy.mockRestore(),
    );
  });

  it.each(["success", "error", "close", "stop"] as const)(
    "reserves a media release until HTTP %s settles",
    async (outcome) => {
      await withProxy(
        false,
        async ({ proxy, front, upstream, server }) => {
          const back = await upstream;
          const body = Buffer.from("held media release");
          server.on("request", (request, response) => {
            response.writeHead(200, { "content-type": "application/octet-stream" });
            response.end(request.url === "/held-release-media" ? body : "ordinary media");
          });
          const port = Number(new URL(proxy.url).port);
          const endEntered = createDeferred<void>();
          const responseClosed = createDeferred<void>();
          const order: string[] = [];
          let response: ServerResponse | undefined;
          let endSpy: { mockRestore(): void } | undefined;
          let resumeEnd: (() => void) | undefined;
          let closeGate: ReturnType<typeof holdCloseNotification> | undefined;
          const onRequest = (message: unknown) => {
            const event = message as {
              server: Server;
              request: IncomingMessage;
              response: ServerResponse;
            };
            const address = event.server.address();
            if (
              response ||
              !address ||
              typeof address === "string" ||
              address.port !== port ||
              event.request.method !== "GET" ||
              event.request.url !== "/held-release-media"
            ) {
              return;
            }
            response = event.response;
            response.once("close", () => responseClosed.resolve());
            if (outcome === "stop") {
              closeGate = holdCloseNotification(response, order, "response-close");
            }
            const originalEnd = response.end;
            endSpy = vi.spyOn(response, "end").mockImplementation(function (
              this: ServerResponse,
              ...args: Parameters<ServerResponse["end"]>
            ) {
              const current = this;
              resumeEnd = () => {
                if (!current.destroyed) {
                  Reflect.apply(originalEnd, current, args);
                }
              };
              endEntered.resolve();
              return this;
            });
          };
          subscribe("http.server.request.start", onRequest);
          const observer = observeProxyServerClose(proxy.url);
          const outbound = observeProxyOutboundClose(server);
          const abort = new AbortController();
          let media: Promise<string> | undefined;
          let releasing: ReturnType<typeof fixtureControl> | undefined;
          let stopped: Promise<void> | undefined;
          let backendClosing: Promise<void> | undefined;
          const closeBackend = () => (backendClosing ??= closeBackendServer(server));
          await runQaGatewayFixture(
            async () => {
              await fixtureControl(proxy, "hold-response", "media.get");
              media = fetch(new URL("/held-release-media", proxy.controlUrl), {
                signal: abort.signal,
              }).then((result) => result.text());
              void media.catch(() => {});
              const held = await fixtureControl(proxy, "wait-held");
              expect(held.heldResponse).toEqual({
                method: "media.get",
                ok: true,
                sizeBytes: body.length,
                sha256: createHash("sha256").update(body).digest("hex"),
              });
              releasing = fixtureControl(proxy, "release-response");
              void releasing.catch(() => {});
              await withTestTimeout(
                Promise.race([
                  endEntered.promise,
                  releasing.then(() => {
                    throw new Error("media release completed before HTTP end");
                  }),
                ]),
                5000,
                "held media response did not reach HTTP end",
              );
              assert(response);
              expect(proxy.snapshot().heldResponse).toBeUndefined();
              expect(proxy.snapshot().events.filter(({ kind }) => kind === "response-released")).toEqual([]);
              await expectFixtureControlRejected(proxy, "hold-response", "users.self");
              await expectFixtureControlRejected(proxy, "release-response");
              expect(
                await fetch(new URL("/ordinary-media", proxy.controlUrl)).then((result) => result.text()),
              ).toBe("ordinary media");

              if (outcome === "stop") {
                assert(closeGate);
                const backendClosed = new Promise<void>((resolve) => back.once("close", resolve));
                stopped = proxy.stop();
                void stopped.then(
                  () => order.push("stop"),
                  () => order.push("stop-error"),
                );
                expect(proxy.stop()).toBe(stopped);
                await withTestTimeout(
                  Promise.all([closeGate.entered, observer.closed, backendClosed, outbound.closed]),
                  5000,
                  "media sockets and proxy listener did not close",
                );
                await closeGatewayTestWebSocket(front);
                await withTestTimeout(closeBackend(), 5000, "backend listener did not close");
                // The socket is gone, but finished(response) still owns the held
                // close notification. Listener closure cannot settle this release.
                expect(response.destroyed).toBe(true);
                expect(proxy.snapshot().firstConnection.some(({ tag }) => tag === "front-close")).toBe(true);
                expect(order).toEqual([]);
                closeGate.release();
                await closeGate.delivered;
                await stopped;
                expect(order).toEqual(["response-close", "stop"]);
                await Promise.allSettled([media, releasing]);
              } else {
                if (outcome === "success") {
                  const finish = resumeEnd;
                  resumeEnd = undefined;
                  assert(finish);
                  finish();
                  expect(await media).toBe(body.toString());
                } else {
                  if (outcome === "error") {
                    response.destroy(new Error("fixture media write failed"));
                  } else {
                    abort.abort();
                  }
                  await withTestTimeout(responseClosed.promise, 5000, "media response did not close");
                  await expect(media).rejects.toThrow();
                }
                await releasing;
                // Success and failed delivery both retire the same reservation.
                await fixtureControl(proxy, "hold-response", "users.self");
              }
              expect(proxy.snapshot().events.filter(({ kind }) => kind === "response-released")).toEqual([
                expect.objectContaining({ method: "media.get", delivered: outcome === "success" }),
              ]);
            },
            () => {
              unsubscribe("http.server.request.start", onRequest);
              const finish = resumeEnd;
              resumeEnd = undefined;
              finish?.();
              closeGate?.release();
              abort.abort();
            },
            async () => {
              stopped ??= proxy.stop();
              await Promise.all([
                media?.catch(() => {}),
                releasing?.catch(() => {}),
                stopped,
              ]);
            },
            () => {
              endSpy?.mockRestore();
              closeGate?.restore();
              observer.dispose();
              outbound.dispose();
            },
            () => backendClosing,
          );
        },
        false,
        false,
        new Set(["/held-release-media"]),
      );
    },
  );

  it.each([
    { method: "users.self", captureReadiness: true, writeFails: false, stopBeforeWrite: false },
    { method: "users.self", captureReadiness: true, writeFails: true, stopBeforeWrite: false },
    { method: "chat.send", captureReadiness: true, writeFails: false, stopBeforeWrite: false },
    { method: "chat.send", captureReadiness: true, writeFails: true, stopBeforeWrite: false },
    { method: "users.self", captureReadiness: false, writeFails: false, stopBeforeWrite: false },
    { method: "users.self", captureReadiness: false, writeFails: true, stopBeforeWrite: false },
    { method: "chat.send", captureReadiness: true, writeFails: true, stopBeforeWrite: true },
  ])(
    "waits for $method write completion (capture=$captureReadiness, failure=$writeFails, stop=$stopBeforeWrite)",
    async ({ method, captureReadiness, writeFails, stopBeforeWrite }) => {
      await withProxy(
        false,
        async ({ proxy, front, upstream, server }) => {
          const back = await upstream;
          await fixtureControl(proxy, "hold-response", method);
          const request = Buffer.from(JSON.stringify({ type: "req", id: "held-write", method }));
          const received = once(back, "message");
          front.send(request);
          expect((await received)[0]).toEqual(request);
          const response = Buffer.from(
            JSON.stringify({ type: "res", id: "held-write", ok: true, payload: {} }),
          );
          back.send(response);
          await fixtureControl(proxy, "wait-held");

          const sendEntered = createDeferred<void>();
          const originalSend = WebSocket.prototype.send;
          let complete: ((error?: Error) => void) | undefined;
          let releasing: ReturnType<typeof fixtureControl> | undefined;
          let writeSocket: WebSocket | undefined;
          let stopped: Promise<void> | undefined;
          let backendClosing: Promise<void> | undefined;
          const closeBackend = () => (backendClosing ??= closeBackendServer(server));
          const order: string[] = [];
          const observer = observeProxyServerClose(proxy.url);
          const outbound = observeProxyOutboundClose(server);
          const send = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
            this: WebSocket,
            data: Parameters<WebSocket["send"]>[0],
            options?: Parameters<WebSocket["send"]>[1] | ((error?: Error) => void),
            callback?: (error?: Error) => void,
          ) {
            if (Buffer.isBuffer(data) && data.equals(response)) {
              writeSocket = this;
              complete = typeof options === "function" ? options : callback;
              sendEntered.resolve();
              return;
            }
            Reflect.apply(originalSend, this, [data, options, callback]);
          });
          await runQaGatewayFixture(
            async () => {
              releasing = fixtureControl(proxy, "release-response");
              void releasing.catch(() => {});
              await withTestTimeout(
                Promise.race([
                  sendEntered.promise,
                  releasing.then(() => {
                    throw new Error("release completed before its send callback");
                  }),
                ]),
                5000,
                "held response send was not reached",
              );
              expect(
                (await fixtureControl(proxy, "snapshot")).events.some(
                  ({ kind }) => kind === "response-released",
                ),
              ).toBe(false);
              await expectFixtureControlRejected(proxy, "hold-response", "media.get");
              await expectFixtureControlRejected(proxy, "release-response");
              if (stopBeforeWrite) {
                assert(writeSocket);
                const frontend = writeSocket;
                expect(frontend.readyState).toBe(WebSocket.OPEN);
                const frontendClosed = new Promise<void>((resolve) => frontend.once("close", resolve));
                const backendClosed = new Promise<void>((resolve) => back.once("close", resolve));
                stopped = proxy.stop();
                void stopped.then(
                  () => order.push("stop"),
                  () => order.push("stop-error"),
                );
                expect(proxy.stop()).toBe(stopped);
                await withTestTimeout(
                  Promise.all([observer.closed, backendClosed, outbound.closed, frontendClosed]),
                  5000,
                  "WebSocket sockets and proxy listener did not close",
                );
                await closeGatewayTestWebSocket(front);
                await withTestTimeout(closeBackend(), 5000, "backend listener did not close");
                expect(order).toEqual([]);
              }
              assert(complete);
              assert(writeSocket);
              const callback = complete;
              complete = undefined;
              order.push("write-callback");
              if (writeFails) {
                callback(new Error("fixture write failed"));
              } else {
                const returned = once(front, "message");
                originalSend.call(writeSocket, response, {}, callback);
                expect((await returned)[0]).toEqual(response);
              }
              if (stopBeforeWrite) {
                await stopped;
                await Promise.allSettled([releasing]);
                expect(order).toEqual(["write-callback", "stop"]);
              } else {
                await releasing;
                await fixtureControl(proxy, "hold-response", "media.get");
              }
              const released = proxy.snapshot();
              expect(released.events.filter(({ kind }) => kind === "response-released")).toEqual([
                expect.objectContaining({ method, delivered: !writeFails }),
              ]);
              const trace = proxy
                .readinessSnapshot()
                .connections[0]?.requests.find((row: { method: string }) => row.method === method);
              if (captureReadiness && method === "users.self") {
                expect(trace?.frontWrite).toEqual({
                  elapsedMs: expect.any(Number),
                  outcome: writeFails ? "error" : "ok",
                });
              } else {
                expect(trace).toBeUndefined();
              }
            },
            () => {
              send.mockRestore();
              complete?.(new Error("fixture cleanup"));
              complete = undefined;
            },
            async () => {
              if (stopBeforeWrite) {
                await Promise.all([releasing?.catch(() => {}), stopped]);
              } else {
                await releasing;
              }
            },
            () => {
              observer.dispose();
              outbound.dispose();
            },
            () => backendClosing,
          );
        },
        captureReadiness,
      );
    },
  );

  it("records a closed frontend as an unsuccessful held release", async () => {
    await withProxy(false, async ({ proxy, front, upstream }) => {
      const back = await upstream;
      await fixtureControl(proxy, "hold-response", "chat.send");
      const received = once(back, "message");
      front.send(JSON.stringify({ type: "req", id: "held-close", method: "chat.send" }));
      await received;
      back.send(JSON.stringify({ type: "res", id: "held-close", ok: true, payload: {} }));
      await fixtureControl(proxy, "wait-held");
      await closeGatewayTestWebSocket(front);
      const released = await fixtureControl(proxy, "release-response");
      expect(released.events.filter(({ kind }) => kind === "response-released")).toEqual([
        expect.objectContaining({ method: "chat.send", delivered: false }),
      ]);
    });
  });
});
