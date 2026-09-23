import { expect } from "playwright/test";
import { it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "confirmed input recovery panel",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:input-recovery";
const sessionId = "input-recovery-session";
const messages = [
  {
    role: "assistant",
    content: "The current answer stays in the conversation.",
    timestamp: 500,
    __openclaw: { id: "answer", seq: 1 },
  },
];
const input = {
  id: "old-input",
  state: "interrupted",
  acceptedAt: 100,
  message: {
    role: "user",
    content: "The old request never started.",
    timestamp: 100,
    __openclaw: { senderId: "fixture-user", senderName: "Fixture User" },
  },
};
const sessionInfo = { key: sessionKey, sessionId, kind: "direct", displayName: "Recovery proof" };
const history = { sessionId, sessionInfo, messages, pendingInputs: { items: [input], total: 1 } };

suite.define(() => {
  it("keeps checks invisible, opens populated content once, and does not reopen dismissed records", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [sessionInfo],
        historyMessages: messages,
        deferredMethods: ["chat.startup"],
        methodResponses: { "chat.history": history },
      });
      await page.addInitScript(
        ({ key, sessionKey: selectedKey }) => {
          localStorage.setItem(
            key,
            JSON.stringify({
              sidebarSessionLayouts: {
                [selectedKey]: { columns: [], open: false, expanded: false },
              },
            }),
          );
        },
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), sessionKey },
      );
      const module = await holdModuleResponse(page, /\/chat-sidebar-region\.runtime\.ts(?:\?|$)/u);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("chat.startup");
      await expect(page.locator(".sidebar-region--open")).toHaveCount(0);
      await gateway.resolveDeferred("chat.startup", history);
      await module.request;
      await expect(
        page.getByText("The current answer stays in the conversation.", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".sidebar-region--open")).toHaveCount(0);
      await expect(page.locator(".chat-input-recovery")).toHaveCount(0);
      await expect(page.locator(".sidebar-region > .panel-loading-skeleton")).toHaveCount(0);
      module.release();
      const panel = page.locator(".chat-input-recovery");
      await expect(panel).toBeVisible();
      await expect(
        panel.getByText("The old request never started.", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".chat-thread")).not.toContainText(
        "The old request never started.",
      );
      await expect(panel.locator(".skeleton,.btn__spinner,[aria-busy=true]")).toHaveCount(0);
      await page.getByRole("button", { name: "Close Not started", exact: true }).click();
      await expect(panel).toHaveCount(0);
      const refreshed = {
        ...history,
        messages: [
          ...messages,
          {
            role: "assistant",
            content: "History refresh applied.",
            timestamp: 600,
            __openclaw: { id: "refresh", seq: 2 },
          },
        ],
      };
      await gateway.setMethodResponse("chat.history", refreshed);
      const before = (await gateway.getRequests("chat.history")).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        agentId: "main",
        reason: "agent.input.settled",
      });
      await gateway.waitForRequest("chat.history", { after: before });
      await expect(
        page.getByRole("paragraph").filter({ hasText: /^History refresh applied\.$/u }),
      ).toBeVisible();
      await expect(page.locator(".sidebar-region--open")).toHaveCount(0);
      await expect(
        page.getByText("The current answer stays in the conversation.", { exact: true }),
      ).toBeVisible();
      const next = {
        ...input,
        id: "new-input",
        message: { ...input.message, content: "A newly interrupted request." },
      };
      await gateway.setMethodResponse("chat.history", {
        ...history,
        pendingInputs: { items: [input, next], total: 2 },
      });
      const refresh = (await gateway.getRequests("chat.history")).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        agentId: "main",
        reason: "agent.input.settled",
      });
      await gateway.waitForRequest("chat.history", { after: refresh });
      await expect(panel).toBeVisible();
      await expect(panel.locator(".chat-input-recovery__card")).toHaveCount(2);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
