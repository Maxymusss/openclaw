import { beforeEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-operator-authority.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  scheduleChatDashboardSessionTitle,
  scheduleCreatedDashboardSessionTitle,
} from "./chat-send-background.js";

const continuation = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../process/gateway-work-admission.js", () => ({
  runWithGatewayIndependentRootWorkContinuation: continuation,
}));

beforeEach(() => {
  continuation.mockClear();
});

it.each(["foreground", "expired", "revoked", "staff", "model-only"] as const)(
  "keeps both optional title producers within their original %s source",
  async (state) => {
    for (const created of [false, true]) {
      continuation.mockClear();
      const source = new AbortController();
      const released = createDeferredCore();
      const retain = vi.fn(() => () => released.resolve());
      const restricted = state !== "staff" && state !== "model-only";
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "title-source",
        scopes: ["operator.write"],
        permissions:
          state === "staff"
            ? undefined
            : {
                models: { allow: ["test-provider/test-model"] },
              },
        ...(restricted
          ? ({
              executionPolicy: "foreground-only",
              foregroundRunId: "original-title-turn",
              foregroundDeadlineAt: Date.now() + (state === "expired" ? -1 : 60_000),
            } as const)
          : {}),
        signal: source.signal,
        assertCurrent: () => source.signal.throwIfAborted(),
        retain,
      });
      if (state === "revoked") {
        source.abort(new Error("original title source revoked"));
      }
      const context = createDirectChatContext({ getRuntimeConfig: () => ({}) });
      const entry = { sessionId: "title-source-session", updatedAt: 1 };
      const sessionKey = "agent:main:dashboard:title-source";
      expect(() => {
        if (created) {
          scheduleCreatedDashboardSessionTitle(
            {
              key: sessionKey,
              agentId: "main",
              entry,
              storePath: "/synthetic/title.sqlite",
              isNew: true,
            },
            {},
            context,
            "Plan the release",
            authority,
          );
        } else {
          scheduleChatDashboardSessionTitle({
            operatorAuthority: authority,
            admittedSessionId: entry.sessionId,
            agentId: "main",
            cfg: {},
            context,
            request: { rawMessage: "Plan the release", normalizedAttachments: [] },
            sessionKey,
            sessionLoadOptions: { agentId: "main" },
            storePath: "/synthetic/title.sqlite",
          });
        }
      }).not.toThrow();
      if (restricted) {
        expect(continuation).not.toHaveBeenCalled();
        expect(retain).not.toHaveBeenCalled();
        expect(context.logGateway.debug).toHaveBeenCalledWith(expect.stringContaining("skipped"));
      } else {
        await released.promise;
        expect(continuation).toHaveBeenCalledTimes(1);
        expect(retain).toHaveBeenCalledTimes(1);
        expect(context.logGateway.debug).not.toHaveBeenCalled();
      }
    }
  },
);
