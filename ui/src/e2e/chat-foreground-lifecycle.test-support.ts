import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { createServer as createProxy, type ViteDevServer } from "vite";
import { expect } from "vitest";
import type {
  GatewayFrame,
  HelloOk,
  RequestFrame,
} from "../../../packages/gateway-protocol/src/schema/frames.ts";
import { readActiveGatewayLockIdentity } from "../../../src/infra/gateway-lock.ts";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../../src/state/user-preferences.ts";
import { ensureProfileForEmail, setUserProfileRole } from "../../../src/state/user-profiles.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { verifyGatewayServedControlUiBundle } from "./control-ui-auth-proof.test-support.ts";

export const fixtureProvider = "foreground-lifecycle";
export const allowedModel = `${fixtureProvider}/allowed`;
export const forbiddenModel = `${fixtureProvider}/forbidden`;
export const savedModelPreference = {
  "new-session.v1:main": { model: forbiddenModel, agentRuntime: "openclaw" },
  "new-session.migration.v1": true,
};
export const restartNotice =
  "The Gateway restarted. This turn was not resumed automatically for security reasons. Your conversation history is preserved. Send a new request to continue.";
const people = ["guest", "uncertain", "restart", "staff"] as const;
export type FixturePerson = (typeof people)[number];
type CleanupMode = "complete" | "hold" | "fail";
type PlannedTurn = {
  id: string;
  mode: CleanupMode;
  text: string;
  ready: number;
  acknowledged: number;
  pid: number | undefined;
  closed: { code: number | null; signal: string | null } | undefined;
  release: (fail?: boolean) => void;
  gate: Promise<{ fail: boolean }>;
};

async function startInferenceFixture() {
  const plans: PlannedTurn[] = [];
  const responses = new Set<ServerResponse>();
  const handlers = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const requests: Array<{ id: string; model: unknown }> = [];
  function plan(mode: CleanupMode, text: string) {
    const gate = createDeferred<{ fail: boolean }>();
    const item: PlannedTurn = {
      id: String(plans.length + 1),
      mode,
      text,
      ready: 0,
      acknowledged: 0,
      pid: undefined,
      closed: undefined,
      release: (fail = mode === "fail") => gate.resolve({ fail }),
      gate: gate.promise,
    };
    if (mode === "complete") {
      item.release(false);
    }
    plans.push(item);
    return item;
  }
  const server = createServer((request, response) => {
    responses.add(response);
    response.once("close", () => responses.delete(response));
    const pending = (async () => {
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
      }
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        const turn = plans[requests.length];
        const parsed = JSON.parse(body) as { model?: unknown };
        requests.push({ id: turn?.id ?? "unplanned", model: parsed.model });
        if (!turn) {
          throw new Error("Unplanned inference request");
        }
        response.setHeader("x-fixture-turn", turn.id);
        response.setHeader("x-fixture-cleanup", turn.mode);
        writeOpenAiResponsesText(response, {
          text: turn.text,
          responseId: `response-${turn.id}`,
          messageId: `message-${turn.id}`,
        });
        return;
      }
      const child = /^\/child\/([0-9]+)\/(ready|termination-ack|cleanup|closed)$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && child) {
        const turn = plans.find((entry) => entry.id === child[1]);
        if (!turn) {
          throw new Error("Unknown fixture child");
        }
        const receipt = JSON.parse(body) as {
          pid?: number;
          code: number | null;
          signal: string | null;
        };
        if (child[2] === "ready") {
          turn.ready += 1;
          turn.pid = receipt.pid;
        }
        if (child[2] === "termination-ack") {
          turn.acknowledged += 1;
        }
        if (child[2] === "closed") {
          turn.closed = { code: receipt.code, signal: receipt.signal };
        }
        if (child[2] === "cleanup") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(await turn.gate));
        } else {
          response.writeHead(204).end();
        }
        return;
      }
      response.writeHead(404).end();
    })();
    handlers.add(pending);
    void pending.then(
      () => handlers.delete(pending),
      (error: unknown) => {
        failures.push(error);
        handlers.delete(pending);
        response.destroy();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture provider did not bind loopback");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    plans,
    plan,
    requests,
    failures,
    releaseAll: () => {
      for (const turn of plans) {
        turn.release(false);
      }
    },
    async close() {
      for (const turn of plans) {
        turn.release(false);
      }
      for (const response of responses) {
        response.destroy();
      }
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      const outcomes = await Promise.allSettled([...handlers, closed]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          failures.push(outcome.reason);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Inference fixture failed");
      }
    },
  };
}

export async function startForegroundLifecycleFixture() {
  const provider = await startInferenceFixture();
  const proxies: ViteDevServer[] = [];
  const identities = new Map<FixturePerson, { url: string; profileId: string }>();
  let instance: OpenClawTestInstance | undefined;
  const close = () =>
    runQaGatewayFixture(
      async () => {
        provider.releaseAll();
      },
      ...proxies.map((proxy) => () => proxy.close()),
      () => instance?.cleanup(),
      () => provider.close(),
    );
  try {
    instance = await createOpenClawTestInstance({
      name: "foreground-lifecycle",
      stopTimeoutMs: 15_000,
      env: {
        VITEST: undefined,
        NODE_ENV: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_NO_RESPAWN: "1",
      },
      config: {
        gateway: {
          controlUi: { enabled: true },
          trustedProxies: ["127.0.0.1", "::1"],
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              allowLoopback: true,
              allowUsers: people.map((person) => `${person}@foreground.example.invalid`),
              userHeader: "x-forwarded-user",
              requiredHeaders: ["x-forwarded-proto"],
              deviceAutoApprove: {
                enabled: true,
                scopes: ["operator.admin", "operator.read", "operator.write"],
              },
            },
          },
          roles: {
            default: "guest",
            definitions: {
              guest: {
                accessPolicyPlugin: fixtureProvider,
                agents: "*",
                sessions: { others: "write" },
                scopes: ["operator.sessions.read", "operator.sessions.write"],
                modelPolicy: { allow: [allowedModel] },
              },
              staff: {
                agents: "*",
                sessions: { others: "write" },
                scopes: ["operator.admin", "operator.read", "operator.write"],
              },
            },
          },
        },
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: {
            skipBootstrap: true,
            timeoutSeconds: 120,
            model: { primary: allowedModel },
            modelPolicy: { allow: [`${fixtureProvider}/*`] },
            models: {
              [allowedModel]: { agentRuntime: { id: "openclaw" }, params: { transport: "sse" } },
              [forbiddenModel]: { agentRuntime: { id: "openclaw" }, params: { transport: "sse" } },
            },
            sandbox: {
              mode: "all",
              backend: "docker",
              scope: "session",
              workspaceAccess: "rw",
              docker: {
                image: process.env.OPENCLAW_SANDBOX_TEST_IMAGE ?? "openclaw-sandbox:bookworm-slim",
                containerPrefix: `oc-ui-foreground-${process.pid}-`,
              },
              browser: { enabled: false },
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
          entries: {
            main: { identity: { name: "Foreground fixture" } },
            staff: { identity: { name: "Staff control" }, sandbox: { mode: "off" } },
          },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            [fixtureProvider]: {
              api: "openai-responses",
              apiKey: "synthetic-unused-key",
              baseUrl: `${provider.origin}/v1`,
              models: [
                { id: "allowed", name: "Allowed fixture model" },
                { id: "forbidden", name: "Forbidden fixture model" },
              ],
            },
          },
        },
        plugins: {
          allow: [fixtureProvider],
          load: {
            paths: [
              fileURLToPath(
                new URL("../../../test/fixtures/foreground-lifecycle", import.meta.url),
              ),
            ],
          },
          slots: { memory: "none" },
          entries: { [fixtureProvider]: { enabled: true, config: { origin: provider.origin } } },
        },
      },
    });
    for (const [index, person] of people.entries()) {
      const email = `${person}@foreground.example.invalid`;
      const profile = ensureProfileForEmail(email, { env: instance.env });
      setUserProfileRole(profile.id, person === "staff" ? "staff" : "guest", { env: instance.env });
      expect(
        await setCanonicalUserPreferences(profile.id, savedModelPreference, { env: instance.env }),
      ).toMatchObject({ ok: true });
      const proxy = await createProxy({
        configFile: false,
        envFile: false,
        root: instance.state.workspaceDir,
        appType: "custom",
        logLevel: "error",
        server: {
          host: "127.0.0.1",
          port: 0,
          proxy: {
            "/": {
              target: `http://127.0.0.1:${instance.port}`,
              ws: true,
              headers: {
                "x-forwarded-for": `192.0.2.${50 + index}`,
                "x-forwarded-proto": "http",
                "x-forwarded-user": email,
              },
            },
          },
        },
      });
      proxies.push(proxy);
      await proxy.listen();
      const url = proxy.resolvedUrls?.local[0];
      if (!url) {
        throw new Error("Identity proxy did not expose its URL");
      }
      identities.set(person, { url, profileId: profile.id });
    }
    const config = JSON.parse(await readFile(instance.configPath, "utf8"));
    delete config.gateway.auth.token;
    config.gateway.controlUi.allowedOrigins = [...identities.values()].map(
      ({ url }) => new URL(url).origin,
    );
    config.agents.defaults.sandbox.workspaceRoot = path.join(instance.stateDir, "sandboxes");
    await instance.state.writeConfig(config);
    await instance.startGateway();
    const bundle = await verifyGatewayServedControlUiBundle(`http://127.0.0.1:${instance.port}/`);
    const owner = instance;
    return {
      instance: owner,
      provider,
      bundle,
      close,
      identity(person: FixturePerson) {
        const identity = identities.get(person);
        if (!identity) {
          throw new Error("Unknown fixture person");
        }
        return identity;
      },
      async savedModelPreference(person: FixturePerson) {
        const identity = identities.get(person);
        if (!identity) {
          throw new Error("Unknown fixture person");
        }
        return (
          await getCanonicalUserPreferences(identity.profileId, Object.keys(savedModelPreference), {
            env: owner.env,
          })
        )?.entries;
      },
      async setGuestModelPolicy(policy: { allow: string[] } | undefined) {
        if (policy) {
          config.gateway.roles.definitions.guest.modelPolicy = policy;
        } else {
          delete config.gateway.roles.definitions.guest.modelPolicy;
        }
        await owner.state.writeConfig(config);
      },
      async restart(staff: Page) {
        const target = await readActiveGatewayLockIdentity({
          env: owner.env,
          requireInspection: true,
        });
        expect(target).toMatchObject({
          pid: owner.child?.pid,
          port: owner.port,
          ownerId: expect.any(String),
        });
        if (!target) {
          throw new Error("Missing exact fixture Gateway lock");
        }
        return await rpc(staff, "gateway.restart.request", {
          target: { pid: target.pid, ownerId: target.ownerId, port: target.port },
          restartIntent: { force: true, drainBudgetMs: 0 },
        });
      },
    };
  } catch (error) {
    return await runQaGatewayFixture(async (): Promise<never> => {
      throw error;
    }, close);
  }
}

export type ForegroundLifecycleFixture = Awaited<
  ReturnType<typeof startForegroundLifecycleFixture>
>;
export function observeForegroundFrames(page: Page) {
  const sent: GatewayFrame[] = [];
  const received: GatewayFrame[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => sent.push(JSON.parse(frame.payload.toString())));
    socket.on("framereceived", (frame) => received.push(JSON.parse(frame.payload.toString())));
  });
  const requests = (method: string) =>
    sent.filter((frame): frame is RequestFrame => frame.type === "req" && frame.method === method);
  const response = (id: string) =>
    received.find((frame) => frame.type === "res" && frame.id === id);
  const hello = () => {
    const request = requests("connect").at(-1);
    const result = request && response(request.id);
    return result?.type === "res" && result.ok ? (result.payload as HelloOk) : undefined;
  };
  return { sent, received, requests, response, hello };
}
export async function rpc(page: Page, method: string, params: Record<string, unknown>) {
  return await page.evaluate(
    async ({ method: requestMethod, params: requestParams }) => {
      const client = document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
        "openclaw-app",
      )?.runtime?.context.gateway.snapshot.client;
      if (!client) {
        throw new Error("Real authenticated Gateway client is missing");
      }
      try {
        return { ok: true as const, payload: await client.request(requestMethod, requestParams) };
      } catch (error) {
        const denied = error as Error & { code?: string };
        return { ok: false as const, error: { code: denied.code, message: denied.message } };
      }
    },
    { method, params },
  );
}
export async function openForegroundPage(
  page: Page,
  fixture: ForegroundLifecycleFixture,
  person: FixturePerson,
  key: string,
) {
  const observed = observeForegroundFrames(page);
  await page.addInitScript(() =>
    localStorage.setItem(
      "openclaw:control-ui:community-invite",
      JSON.stringify({ dismissedAtMs: 1770000000000 }),
    ),
  );
  await page.goto(new URL("settings/profile", fixture.identity(person).url).href);
  await waitForControlUiGatewayReady(page);
  const created = await rpc(page, "sessions.create", {
    key,
    agentId: person === "staff" ? "staff" : "main",
    label: "Foreground lifecycle fixture",
    visibility: "shared",
  });
  expect(created, created.ok ? undefined : JSON.stringify(created.error)).toMatchObject({
    ok: true,
  });
  await page.goto(controlUiSessionUrl(fixture.identity(person).url, key));
  await waitForControlUiGatewayReady(page);
  await expect.poll(observed.hello).toMatchObject({
    auth: {
      method: "trusted-proxy",
      ...(person === "staff" ? {} : { executionPolicy: "foreground-only", modelRestricted: true }),
    },
  });
  if (person === "staff") {
    expect(observed.hello()?.auth.executionPolicy).toBeUndefined();
    expect(observed.hello()?.auth.modelRestricted).toBeUndefined();
  }
  return observed;
}
export const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Chat composer", exact: true });
export async function sendForegroundMessage(
  page: Page,
  observed: ReturnType<typeof observeForegroundFrames>,
  message: string,
) {
  const before = observed.requests("chat.send").length;
  await composer(page).fill(message);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => observed.requests("chat.send").length).toBe(before + 1);
  const request = observed.requests("chat.send")[before]!;
  if (request.type !== "req") {
    throw new Error("Expected the real chat.send request");
  }
  await expect.poll(() => observed.response(request.id)).toBeDefined();
  return request;
}
export async function history(page: Page, key: string) {
  const result = await rpc(page, "chat.history", { sessionKey: key });
  expect(result).toMatchObject({ ok: true });
  const payload = result.ok ? asNullableRecord(result.payload) : null;
  if (!payload || !Array.isArray(payload.messages)) {
    throw new Error("Missing real chat history");
  }
  const pending = asNullableRecord(payload.pendingInputs);
  if (!pending || !Array.isArray(pending.items) || typeof pending.total !== "number") {
    throw new Error("Missing canonical pending-input page");
  }
  return {
    messages: payload.messages,
    pending,
    sessionInfo: asNullableRecord(payload.sessionInfo),
  };
}

export function historyText(messages: readonly unknown[]): string[] {
  return messages.flatMap((message) => {
    const content = asNullableRecord(message)?.content;
    if (typeof content === "string") {
      return [content];
    }
    return Array.isArray(content)
      ? content.flatMap((part) => {
          const text = asNullableRecord(part)?.text;
          return typeof text === "string" ? [text] : [];
        })
      : [];
  });
}

export function hasTerminalEvent(
  observed: ReturnType<typeof observeForegroundFrames>,
  runId: string,
) {
  return observed.received.some((frame) => {
    if (frame.type !== "event" || frame.event !== "chat") {
      return false;
    }
    const payload = asNullableRecord(frame.payload);
    return (
      payload?.runId === runId && ["aborted", "error", "final"].includes(String(payload.state))
    );
  });
}

export async function waitForReleasedThread(page: Page, key: string) {
  await expect.poll(async () => (await history(page, key)).sessionInfo?.hasActiveRun).toBe(false);
}
