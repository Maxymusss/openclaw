// Real identities, built UI, builtin inference and response-owned child cleanup.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { isPidAlive } from "../../../src/shared/pid-alive.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  allowedModel,
  forbiddenModel,
  composer,
  hasTerminalEvent,
  history,
  historyText,
  openForegroundPage,
  restartNotice,
  rpc,
  sendForegroundMessage,
  startForegroundLifecycleFixture,
  waitForReleasedThread,
  type ForegroundLifecycleFixture,
  type observeForegroundFrames,
} from "./chat-foreground-lifecycle.test-support.ts";
import {
  createControlUiE2eSuite,
  createControlUiE2eContextOptions,
} from "./control-ui-e2e-suite.test-support.ts";

let fixture: ForegroundLifecycleFixture;
const suite = createControlUiE2eSuite({
  name: "Real foreground lifecycle and finite model access",
  startServerBeforeBrowser: true,
  async startServer() {
    fixture = await startForegroundLifecycleFixture();
    return { baseUrl: fixture.identity("guest").url, close: fixture.close };
  },
});
type Observation = ReturnType<typeof observeForegroundFrames>;
type Turn = ReturnType<ForegroundLifecycleFixture["provider"]["plan"]>;
const cleanupRefusal = "Cleanup of the previous turn could not be confirmed";
const thread = (page: Page) => page.locator('openclaw-chat-pane[aria-hidden="false"]');
const send = (page: Page) => page.getByRole("button", { name: "Send message", exact: true });

async function accepted(page: Page, observed: Observation, message: string, turn: Turn) {
  const request = await sendForegroundMessage(page, observed, message);
  const params = asNullableRecord(request.params);
  if (typeof params?.idempotencyKey !== "string") {
    throw new Error("Missing actual run identity");
  }
  expect(observed.response(request.id)).toMatchObject({
    ok: true,
    payload: { runId: params.idempotencyKey, status: "started" },
  });
  await expect.poll(() => turn.ready).toBe(1);
  expect(fixture.provider.requests.at(-1)).toEqual({ id: turn.id, model: "allowed" });
  return params.idempotencyKey;
}

async function completed(
  page: Page,
  observed: Observation,
  key: string,
  message: string,
  reply: string,
) {
  const turn = fixture.provider.plan("complete", reply);
  const runId = await accepted(page, observed, message, turn);
  await expect.poll(() => turn.closed).toEqual({ code: 0, signal: null });
  await expect.poll(() => hasTerminalEvent(observed, runId)).toBe(true);
  await expect.poll(() => thread(page).getByText(reply, { exact: true }).count()).toBe(1);
  await waitForReleasedThread(page, key);
  return runId;
}

async function stopWithHeldCleanup(page: Page, observed: Observation, runId: string, turn: Turn) {
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
  await expect.poll(() => turn.acknowledged).toBe(1);
  await expect.poll(() => hasTerminalEvent(observed, runId)).toBe(true);
  expect(turn.closed).toBeUndefined();
  if (!turn.pid) {
    throw new Error("Missing owned child PID");
  }
  // This is the fixture's local child, not a Linux container PID on another host.
  expect(isPidAlive(turn.pid)).toBe(true);
}

async function deniedSend(page: Page, observed: Observation, text: string, message: string) {
  const request = await sendForegroundMessage(page, observed, text);
  expect(observed.response(request.id)).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", message: expect.stringContaining(message) },
  });
  await expect
    .poll(() => thread(page).getByText(message, { exact: false }).count())
    .toBeGreaterThan(0);
  await expect.poll(() => composer(page).inputValue()).toBe(text);
}

suite.define(() => {
  it("holds the stopped guest thread until actual child close, then accepts a fresh finite request", async (context) => {
    await suite.runScenario(context, {
      retainedState: () => fixture.instance.stateDir,
      close: async () => {
        fixture.provider.releaseAll();
      },
      run: async () =>
        suite.withPage(createControlUiE2eContextOptions(), async ({ page: staff }) => {
          const staffKey = "agent:staff:foreground-control";
          const staffObserved = await openForegroundPage(staff, fixture, "staff", staffKey);
          await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
            const key = "agent:main:foreground-held";
            const observed = await openForegroundPage(page, fixture, "guest", key);
            expect(fixture.bundle.assetSha256).toMatch(/^[a-f0-9]{64}$/u);
            expect(await rpc(page, "sessions.patch", { key, model: forbiddenModel })).toMatchObject(
              { ok: false, error: { code: "FORBIDDEN" } },
            );
            // A real staff mutation selects a model hidden from this guest's catalog.
            // The next ordinary UI send must still be refused by the original caller policy.
            expect(
              await rpc(staff, "sessions.patch", { key, model: forbiddenModel }),
            ).toMatchObject({ ok: true });
            const beforeForbidden = fixture.provider.requests.length;
            const denied = await sendForegroundMessage(
              page,
              observed,
              "Try the forbidden saved model",
            );
            const forbiddenRun = asNullableRecord(denied.params)?.idempotencyKey;
            if (typeof forbiddenRun !== "string") {
              throw new Error("Missing forbidden selection run identity");
            }
            expect(observed.response(denied.id)).toMatchObject({
              ok: true,
              payload: { status: "started" },
            });
            await expect.poll(() => hasTerminalEvent(observed, forbiddenRun)).toBe(true);
            await expect
              .poll(() =>
                thread(page)
                  .getByText("Your operator role does not allow this model", { exact: false })
                  .count(),
              )
              .toBeGreaterThan(0);
            await waitForReleasedThread(page, key);
            expect(fixture.provider.requests).toHaveLength(beforeForbidden);
            expect(await rpc(staff, "sessions.patch", { key, model: allowedModel })).toMatchObject({
              ok: true,
            });
            await page.reload();
            await waitForControlUiGatewayReady(page);

            const turn = fixture.provider.plan("hold", "This held response must not replay.");
            const runId = await accepted(page, observed, "Hold this turn until I stop it", turn);
            const draft = "Keep this text for my next explicit request";
            await composer(page).fill(draft);
            const sendsBefore = observed.requests("chat.send").length;
            await composer(page).press("Enter");
            await expect
              .poll(() =>
                thread(page).getByText("Your draft has not been queued", { exact: false }).count(),
              )
              .toBeGreaterThan(0);
            expect(await composer(page).inputValue()).toBe(draft);
            expect((await history(page, key)).pending).toMatchObject({ items: [], total: 0 });
            expect(observed.requests("chat.send")).toHaveLength(sendsBefore);
            await stopWithHeldCleanup(page, observed, runId, turn);
            expect(await composer(page).inputValue()).toBe(draft);
            const busy = await rpc(page, "chat.send", {
              sessionKey: key,
              message: draft,
              idempotencyKey: randomUUID(),
            });
            expect(busy).toMatchObject({
              ok: false,
              error: { message: expect.stringContaining("still running") },
            });
            expect(fixture.provider.requests).toHaveLength(beforeForbidden + 1);
            expect((await history(page, key)).pending).toMatchObject({ items: [], total: 0 });

            await completed(
              staff,
              staffObserved,
              staffKey,
              "Staff can still work",
              "Independent staff response.",
            );
            expect(turn.closed).toBeUndefined();
            turn.release(false);
            await expect.poll(() => turn.closed).toEqual({ code: 0, signal: null });
            expect(isPidAlive(turn.pid!)).toBe(false);
            await waitForReleasedThread(page, key);
            await expect.poll(() => send(page).isEnabled()).toBe(true);
            expect(await composer(page).inputValue()).toBe(draft);
            await thread(page).screenshot({
              path: path.join(suite.artifactDir, "stop-draft.png"),
              animations: "disabled",
            });
            const fresh = await completed(
              page,
              observed,
              key,
              draft,
              "Fresh guest response after verified close.",
            );
            expect(fresh).not.toBe(runId);
            expect(fixture.provider.failures).toEqual([]);
          });
        }),
    });
  });

  it("retains cleanup uncertainty after actual role promotion and identity reconnect", async (context) => {
    await suite.runScenario(context, {
      retainedState: () => fixture.instance.stateDir,
      close: async () => {
        fixture.provider.releaseAll();
      },
      run: async () =>
        suite.withPage(createControlUiE2eContextOptions(), async ({ page: staff }) => {
          await openForegroundPage(staff, fixture, "staff", "agent:staff:foreground-promotion");
          await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
            const key = "agent:main:foreground-uncertain";
            const observed = await openForegroundPage(page, fixture, "uncertain", key);
            const turn = fixture.provider.plan(
              "fail",
              "Unconfirmed cleanup must block this thread.",
            );
            const runId = await accepted(
              page,
              observed,
              "Exercise the failed cleanup acknowledgement",
              turn,
            );
            await stopWithHeldCleanup(page, observed, runId, turn);
            turn.release(true);
            await expect.poll(() => turn.closed).toEqual({ code: 23, signal: null });
            expect(isPidAlive(turn.pid!)).toBe(false);
            await waitForReleasedThread(page, key);
            const requests = fixture.provider.requests.length;
            const draft = "Keep this draft while cleanup is unresolved";
            await deniedSend(page, observed, draft, cleanupRefusal);
            expect(fixture.provider.requests).toHaveLength(requests);
            expect((await history(page, key)).pending).toMatchObject({ items: [], total: 0 });
            const connection = observed.hello()?.server.connId;
            expect(
              await rpc(staff, "users.setRole", {
                profileId: fixture.identity("uncertain").profileId,
                role: "staff",
              }),
            ).toMatchObject({ ok: true });
            await expect
              .poll(() =>
                Boolean(observed.hello() && observed.hello()?.server.connId !== connection),
              )
              .toBe(true);
            await waitForControlUiGatewayReady(page);
            expect(observed.hello()?.auth.executionPolicy).toBeUndefined();
            expect(observed.hello()?.auth.modelRestricted).toBeUndefined();
            expect(await composer(page).inputValue()).toBe(draft);
            expect(fixture.provider.requests).toHaveLength(requests);
            await deniedSend(page, observed, draft, cleanupRefusal);
            expect((await history(page, key)).pending).toMatchObject({ items: [], total: 0 });
            expect(fixture.provider.requests).toHaveLength(requests);
            expect(turn.closed).toEqual({ code: 23, signal: null });
            await thread(page).screenshot({
              path: path.join(suite.artifactDir, "cleanup-refusal.png"),
              animations: "disabled",
            });
          });
        }),
    });
  });

  it("restarts the actual Gateway without replay and renders the canonical notice once", async (context) => {
    await suite.runScenario(context, {
      retainedState: () => fixture.instance.stateDir,
      close: async () => {
        fixture.provider.releaseAll();
      },
      run: async () =>
        suite.withPage(createControlUiE2eContextOptions(), async ({ page: staff }) => {
          await openForegroundPage(staff, fixture, "staff", "agent:staff:foreground-restart");
          await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
            const key = "agent:main:foreground-restart";
            const observed = await openForegroundPage(page, fixture, "restart", key);
            const earlier = "Earlier conversation survives restart.";
            await completed(page, observed, key, "Remember this earlier request", earlier);
            const turn = fixture.provider.plan("hold", "Interrupted response must not resume.");
            const interrupted = await accepted(
              page,
              observed,
              "Interrupt this request with a real restart",
              turn,
            );
            const sendsBeforeRestart = observed.requests("chat.send").length;
            const draft = "Only send this after my explicit action";
            await composer(page).fill(draft);
            const requests = fixture.provider.requests.length;
            const connection = observed.hello()?.server.connId;
            const child = fixture.instance.child;
            const stateDir = fixture.instance.stateDir;
            expect(await fixture.restart(staff)).toMatchObject({ ok: true });
            await expect.poll(() => turn.acknowledged).toBe(1);
            expect(turn.closed).toBeUndefined();
            turn.release(false);
            await expect.poll(() => turn.closed).toEqual({ code: 0, signal: null });
            await expect
              .poll(() =>
                Boolean(observed.hello() && observed.hello()?.server.connId !== connection),
              )
              .toBe(true);
            await waitForControlUiGatewayReady(page);
            expect(fixture.instance.child).toBe(child);
            expect(child?.exitCode).toBeNull();
            expect(fixture.instance.stateDir).toBe(stateDir);
            await expect
              .poll(() => thread(page).getByText(restartNotice, { exact: true }).count())
              .toBe(1);
            const recovered = await history(page, key);
            expect(
              historyText(recovered.messages).filter((text) => text === restartNotice),
            ).toHaveLength(1);
            expect(historyText(recovered.messages)).toContain(earlier);
            expect(recovered.pending).toMatchObject({ items: [], total: 0 });
            expect(fixture.provider.requests).toHaveLength(requests);
            expect(observed.requests("chat.send")).toHaveLength(sendsBeforeRestart);
            expect(await composer(page).inputValue()).toBe(draft);
            await page.reload();
            await waitForControlUiGatewayReady(page);
            await expect
              .poll(() => thread(page).getByText(restartNotice, { exact: true }).count())
              .toBe(1);
            expect(
              historyText((await history(page, key)).messages).filter(
                (text) => text === restartNotice,
              ),
            ).toHaveLength(1);
            expect(fixture.provider.requests).toHaveLength(requests);
            expect(observed.requests("chat.send")).toHaveLength(sendsBeforeRestart);
            await thread(page).screenshot({
              path: path.join(suite.artifactDir, "restart-notice.png"),
              animations: "disabled",
            });
            const fresh = await completed(
              page,
              observed,
              key,
              draft,
              "Explicit request after restart.",
            );
            expect(fresh).not.toBe(interrupted);
            expect(fixture.provider.requests).toHaveLength(requests + 1);
          });
        }),
    });
  });
});
