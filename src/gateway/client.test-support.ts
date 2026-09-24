import { vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/frame-guards.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";

export function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

export function firstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [arg] = mock.mock.calls[0] ?? [];
  if (arg === undefined) {
    throw new Error(`expected ${label}`);
  }
  return arg;
}

export function createAuthFailureMessage(): string {
  const failureUrl = new URL("wss://gateway.example/ws?token=secret-token");
  failureUrl.username = "user";
  failureUrl.password = "pass";
  return `Authorization: Bearer sk-testsecret1234567890abcd ${failureUrl.href}`; // pragma: allowlist secret
}

export function emitConnectFailure(
  ws: { emitMessage(data: string): void },
  connectId: string | undefined,
  details: Record<string, unknown>,
  message = "unauthorized",
) {
  ws.emitMessage(
    JSON.stringify({
      type: "res",
      id: connectId,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message,
        details,
      },
    }),
  );
}

export function emitHelloOk(
  ws: { emitMessage(data: string): void },
  connectId: string | undefined,
  protocol: number = PROTOCOL_VERSION,
  auth: HelloOk["auth"] = { role: "operator", scopes: ["operator.admin"] },
) {
  ws.emitMessage(
    JSON.stringify({
      type: "res",
      id: connectId,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol,
        auth,
      },
    }),
  );
}
