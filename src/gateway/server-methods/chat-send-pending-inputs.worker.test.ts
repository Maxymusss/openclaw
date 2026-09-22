import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.pending-inputs.js";
import * as custody from "../../config/sessions/session-pending-input-stage.runtime.js";
import { createRequiredSharedGatewaySessionGenerationReader } from "../server-shared-auth-generation.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import * as sharingPolicy from "../session-sharing-policy.js";
import { installGatewayTestHooks } from "../test-helpers.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();

it("the authenticated chat route stages approved input off-thread before ACK", async () => {
  const fixture = await createFixture();
  const client = createOperatorWsClient({ connId: fixture.client.connId });
  client.connect = fixture.client.connect;
  const harness = createDispatchTestHarness({
    connId: client.connId,
    getRequiredSharedGatewaySessionGeneration: createRequiredSharedGatewaySessionGenerationReader({
      current: "custody",
      required: null,
    }),
    buildRequestContext: () => fixture.context,
    extraHandlers: { "chat.send": handleChatSend },
  });
  const legacySharing = vi
    .spyOn(sharingPolicy, "resolveSessionSharingTarget")
    .mockImplementation(() => {
      throw new Error("Native sharing resolution reached the asynchronous chat route");
    });
  const original = custody.withPendingInputStageStorage;
  let staged = false;
  const spy = vi
    .spyOn(custody, "withPendingInputStageStorage")
    .mockImplementation(async (scope, options, run) => {
      expect(options.workerAuthority).toBeDefined();
      const host = observeHostDataSql();
      try {
        const receipt = await original(scope, options, run);
        expect(host.calls.flatMap((call) => call.mock.calls)).toEqual([]);
        staged = true;
        return receipt;
      } finally {
        host.restore();
      }
    });
  try {
    await harness.dispatcher.dispatch(
      { type: "req", id: "worker-custody", method: "chat.send", params: fixture.params },
      client,
    );
    const response = await harness.awaitResponseFrame("worker-custody");
    expect(response.ok, response.error?.message).toBe(true);
    expect(spy.mock.calls.length, "actual route reached pending input storage").toBe(1);
    expect(staged).toBe(true);
    expect(fixture.beforeApprove).toHaveBeenCalledTimes(1);
    expect(listSessionPendingInputs(fixture.scope).items).toMatchObject([
      { message: { content: fixture.approvedContent } },
    ]);
  } finally {
    spy.mockRestore();
    legacySharing.mockRestore();
    await fixture.cleanup();
  }
});
