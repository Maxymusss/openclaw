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
  fixtureProvider,
  forbiddenModel,
  savedModelPreference,
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
  withForegroundTurnDiagnostics,
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
  await withForegroundTurnDiagnostics(fixture, observed, params.idempotencyKey, turn, () =>
    expect.poll(() => turn.ready).toBe(1),
  );
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
  await withForegroundTurnDiagnostics(fixture, observed, runId, turn, () =>
    expect.poll(() => hasTerminalEvent(observed, runId)).toBe(true),
  );
  await expect.poll(() => thread(page).getByText(reply, { exact: true }).count()).toBe(1);
  await waitForReleasedThread(page, key);
  return runId;
}

async function stopWithHeldCleanup(page: Page, observed: Observation, runId: string, turn: Turn) {
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
  await expect.poll(() => turn.acknowledged).toBe(1);
  await withForegroundTurnDiagnostics(fixture, observed, runId, turn, () =>
    expect.poll(() => hasTerminalEvent(observed, runId)).toBe(true),
  );
  expect(turn.closed).toBeUndefined();
  if (!turn.pid) {
    throw new Error("Missing owned child PID");
  }
  // This is the fixture's local child, not a Linux container PID on another host.
  expect(isPidAlive(turn.pid)).toBe(true);
}

async function deniedSend(page: Page, observed: Observation, text: string, message: string) {
  const request = await sendForegroundMessage(page, observed, text);
  const response = observed.response(request.id);
  expect(response).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", message: expect.stringContaining(message) },
  });
  if (response?.type !== "res" || response.ok || typeof response.error?.message !== "string") {
    throw new Error("Missing definitive send refusal");
  }
  const runId = asNullableRecord(request.params)?.idempotencyKey;
  if (typeof runId !== "string") {
    throw new Error("Missing rejected submission identity");
  }
  // Pending user rows retain the original send identity through reconnect.
  const rowKey = `group:user:msg:send:${runId}:0`;
  const failed = thread(page).locator(`[data-chat-row-key="${rowKey}"]`);
  const status = failed.locator('.chat-send-status[data-send-state="failed"]');
  await expect.poll(() => failed.count()).toBe(1);
  await expect.poll(() => failed.getByText(text, { exact: true }).count()).toBe(1);
  await expect.poll(() => status.getByText("Not sent", { exact: true }).count()).toBe(1);
  await expect.poll(() => status.getAttribute("title")).toBe(response.error.message);
  await expect.poll(() => composer(page).inputValue()).toBe("");
  return { failed, status, rowKey, diagnostic: response.error.message };
}

async function expectRestartNotice(page: Page, key: string) {
  const notices = thread(page).getByText(restartNotice, { exact: true });
  try {
    await expect.poll(() => notices.count()).toBe(1);
  } catch (error) {
    // History can reconcile the live transcript; capture the failed DOM first.
    const activeThreads = await thread(page)
      .count()
      .catch(() => null);
    const dom = await notices
      .evaluateAll((elements) => ({
        count: elements.length,
        matches: elements.slice(0, 8).map((element) => {
          const attribute = (owner: Element | null, name: string) =>
            owner?.getAttribute(name)?.slice(0, 160) ?? null;
          const details = element.closest("details");
          const alert = element.closest('[role="alert"]');
          const pane = element.closest("openclaw-chat-pane");
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            tag: element.tagName.toLowerCase().slice(0, 32),
            class: attribute(element, "class"),
            bounds: { width: bounds.width, height: bounds.height },
            computedStyle: { visibility: style.visibility, display: style.display },
            messageId: attribute(element.closest("[data-message-id]"), "data-message-id"),
            entryId: attribute(element.closest("[data-entry-id]"), "data-entry-id"),
            rowKey: attribute(element.closest("[data-chat-row-key]"), "data-chat-row-key"),
            details: details
              ? { class: attribute(details, "class"), open: details.hasAttribute("open") }
              : null,
            alert: alert
              ? { tag: alert.tagName.toLowerCase().slice(0, 32), class: attribute(alert, "class") }
              : null,
            pane: pane
              ? {
                  index: Array.from(document.querySelectorAll("openclaw-chat-pane")).indexOf(pane),
                  class: attribute(pane, "class"),
                  ariaHidden: attribute(pane, "aria-hidden"),
                  hidden: pane.hasAttribute("hidden"),
                  inert: pane.hasAttribute("inert"),
                }
              : null,
          };
        }),
      }))
      .catch(() => ({ unavailable: true }));
    const firstThreadScreenshot = await thread(page)
      .first()
      .screenshot({
        path: path.join(suite.artifactDir, "restart-notice.png"),
        animations: "disabled",
      })
      .then(
        () => true,
        () => false,
      );
    const stored = await history(page, key)
      .then(({ messages }) => {
        const matching = messages.filter((message) =>
          historyText([message]).includes(restartNotice),
        );
        const identity = (value: unknown) =>
          typeof value === "string" ? value.slice(0, 160) : null;
        return {
          count: historyText(messages).filter((text) => text === restartNotice).length,
          messageCount: matching.length,
          messages: matching.slice(0, 8).map((message) => {
            const metadata = asNullableRecord(asNullableRecord(message)?.__openclaw);
            return {
              id: identity(metadata?.id),
              runId: identity(metadata?.runId),
              idempotencyKey: identity(metadata?.idempotencyKey),
            };
          }),
        };
      })
      .catch(() => ({ unavailable: true }));
    throw new Error(
      `Restart notice assertion failed: ${JSON.stringify({ activeThreads, dom, firstThreadScreenshot, stored })}`,
      { cause: error },
    );
  }
}

suite.define(() => {
  it("refreshes model policy on the same narrow guest connection without synthesizing forbidden choices", async (context) => {
    await suite.runScenario(context, {
      retainedState: () => fixture.instance.stateDir,
      close: async () => {
        fixture.provider.releaseAll();
      },
      run: async () =>
        suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
          const key = "agent:main:live-model-policy";
          const observed = await openForegroundPage(page, fixture, "guest", key);
          const hello = observed.hello();
          const connId = hello?.server.connId;
          expect(await fixture.savedModelPreference("guest")).toEqual(savedModelPreference);
          expect(connId).toBeTruthy();
          expect(observed.hello()?.auth.scopes).not.toContain("operator.read");
          const picker = thread(page).locator("details.chat-controls__model-picker");
          await picker.locator(":scope > summary").click();
          const changed = async (restricted: boolean) => {
            const events = observed.received.filter(
              (frame) => frame.type === "event" && frame.event === "chat.metadata.changed",
            ).length;
            const catalogsForSession = () =>
              observed
                .requests("models.list")
                .filter((request) => asNullableRecord(request.params)?.sessionKey === key);
            const catalogs = catalogsForSession().length;
            await fixture.setGuestModelPolicy(restricted ? { allow: [allowedModel] } : undefined);
            try {
              await expect
                .poll(
                  () =>
                    observed.received.filter(
                      (frame) => frame.type === "event" && frame.event === "chat.metadata.changed",
                    ).length,
                )
                .toBeGreaterThan(events);
            } catch (error) {
              const reload = fixture.instance
                .logs()
                .split("\n")
                .filter((line) => /config (?:hot-)?reload|config change detected/.test(line))
                .slice(-20)
                .join("\n")
                .slice(-4_000);
              throw new Error(
                `Model-policy refresh failed (restricted=${restricted}).\n${reload}`,
                { cause: error },
              );
            }
            await expect.poll(() => catalogsForSession().length).toBeGreaterThan(catalogs);
            await expect
              .poll(() => {
                const request = catalogsForSession().at(-1);
                const response = request && observed.response(request.id);
                return response?.type === "res" && response.ok
                  ? asNullableRecord(response.payload)?.modelRestricted === true
                  : null;
              })
              .toBe(restricted);
            expect(observed.hello()).toEqual(hello);
            expect(observed.hello()?.server.connId).toBe(connId);
            expect(await fixture.savedModelPreference("guest")).toEqual(savedModelPreference);
            await expect
              .poll(() => picker.locator(`[data-chat-model-option="${forbiddenModel}"]`).count())
              .toBe(restricted ? 0 : 1);
          };
          try {
            await changed(false);
            await changed(true);
            expect(await rpc(page, "sessions.patch", { key, model: forbiddenModel })).toMatchObject(
              { ok: false, error: { code: "FORBIDDEN" } },
            );
            await picker.locator(":scope > summary").click();
            await completed(
              page,
              observed,
              key,
              "Use the approved route after policy refresh",
              "Approved policy refresh response",
            );
            expect(fixture.provider.requests.every((request) => request.model === "allowed")).toBe(
              true,
            );
            await picker.locator(":scope > summary").click();
            await changed(false);
            expect(observed.hello()?.auth.modelRestricted).toBe(true);
            await changed(true);
          } finally {
            await fixture.setGuestModelPolicy({ allow: [allowedModel] });
          }
        }),
    });
  });

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
            // An explicit inline selection must be refused without changing the shared pin.
            expect(
              await rpc(staff, "sessions.patch", { key, model: forbiddenModel }),
            ).toMatchObject({ ok: true });
            const readStaffPin = async () => {
              const result = await rpc(staff, "sessions.list", {
                agentId: "main",
                label: `Foreground lifecycle fixture: ${key}`,
              });
              expect(result).toMatchObject({ ok: true });
              const sessions = result.ok ? asNullableRecord(result.payload)?.sessions : undefined;
              if (!Array.isArray(sessions)) {
                throw new Error("Missing staff session list");
              }
              expect(sessions).toHaveLength(1);
              const row = asNullableRecord(sessions[0]);
              if (typeof row?.sessionId !== "string" || !row.sessionId) {
                throw new Error("Missing pinned session identity");
              }
              return {
                key: row.key,
                sessionId: row.sessionId,
                modelProvider: row.modelProvider,
                model: row.model,
                modelOverrideSource: row.modelOverrideSource,
              };
            };
            const savedPin = await readStaffPin();
            expect(savedPin).toEqual({
              key,
              sessionId: expect.any(String),
              modelProvider: fixtureProvider,
              model: "forbidden",
              modelOverrideSource: "user",
            });
            const beforeForbidden = fixture.provider.requests.length;
            const denied = await sendForegroundMessage(
              page,
              observed,
              `please reply /model ${forbiddenModel} /think off`,
            );
            const deniedParams = asNullableRecord(denied.params);
            expect(deniedParams).toMatchObject({ sessionKey: key });
            expect(deniedParams).not.toHaveProperty("model");
            const forbiddenRun = deniedParams?.idempotencyKey;
            if (typeof forbiddenRun !== "string") {
              throw new Error("Missing forbidden selection run identity");
            }
            expect(observed.response(denied.id)).toMatchObject({
              ok: true,
              payload: { status: "started" },
            });
            await withForegroundTurnDiagnostics(
              fixture,
              observed,
              forbiddenRun,
              undefined,
              async () => {
                await expect.poll(() => hasTerminalEvent(observed, forbiddenRun)).toBe(true);
                await expect
                  .poll(() =>
                    thread(page)
                      .getByText("Your operator role cannot use this model", { exact: false })
                      .count(),
                  )
                  .toBeGreaterThan(0);
              },
            );
            await waitForReleasedThread(page, key);
            expect(fixture.provider.requests).toHaveLength(beforeForbidden);
            expect(await readStaffPin()).toEqual(savedPin);
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
            await thread(page).screenshot({
              path: path.join(suite.artifactDir, "stop-running.png"),
              animations: "disabled",
            });
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
            await thread(page).screenshot({
              path: path.join(suite.artifactDir, "cleanup-pending.png"),
              animations: "disabled",
            });
            turn.release(true);
            await expect.poll(() => turn.closed).toEqual({ code: 23, signal: null });
            expect(isPidAlive(turn.pid!)).toBe(false);
            await waitForReleasedThread(page, key);
            const requests = fixture.provider.requests.length;
            const draft = "Keep this draft while cleanup is unresolved";
            const rejected = await deniedSend(page, observed, draft, cleanupRefusal);
            expect(await rejected.failed.locator(".chat-send-status__retry").count()).toBe(0);
            expect(fixture.provider.requests).toHaveLength(requests);
            expect((await history(page, key)).pending).toMatchObject({ items: [], total: 0 });
            const sendsBeforePromotion = observed.requests("chat.send").length;
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
            expect(await composer(page).inputValue()).toBe("");
            expect(await rejected.failed.getAttribute("data-chat-row-key")).toBe(rejected.rowKey);
            expect(await rejected.failed.getByText(draft, { exact: true }).count()).toBe(1);
            expect(await rejected.status.getByText("Not sent", { exact: true }).count()).toBe(1);
            expect(await rejected.status.getAttribute("title")).toBe(rejected.diagnostic);
            expect(observed.requests("chat.send")).toHaveLength(sendsBeforePromotion);
            expect(fixture.provider.requests).toHaveLength(requests);
            await deniedSend(
              page,
              observed,
              "New explicit request after promotion",
              cleanupRefusal,
            );
            expect(await rejected.failed.getAttribute("data-chat-row-key")).toBe(rejected.rowKey);
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
            expect(await fixture.savedModelPreference("restart")).toEqual(savedModelPreference);
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
            await thread(page).screenshot({
              path: path.join(suite.artifactDir, "restart-running.png"),
              animations: "disabled",
            });
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
            expect(await fixture.savedModelPreference("restart")).toEqual(savedModelPreference);
            await expectRestartNotice(page, key);
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
            await expectRestartNotice(page, key);
            expect(
              historyText((await history(page, key)).messages).filter(
                (text) => text === restartNotice,
              ),
            ).toHaveLength(1);
            expect(fixture.provider.requests).toHaveLength(requests);
            expect(observed.requests("chat.send")).toHaveLength(sendsBeforeRestart);
            const picker = thread(page).locator("details.chat-controls__model-picker");
            await picker.locator(":scope > summary").click();
            expect(
              await picker.locator(`[data-chat-model-option="${forbiddenModel}"]`).count(),
            ).toBe(0);
            expect(await fixture.savedModelPreference("restart")).toEqual(savedModelPreference);
            await picker.locator(":scope > summary").click();
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
