import { expect, it } from "vitest";
import { buildEmbeddedRunBaseParams } from "../../auto-reply/reply/agent-runner-run-params.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { createSessionMaintenanceFollowup } from "./run.js";

it("preserves original model authority without foreground tool or writer custody", async () => {
  const original = createAdmittedRunOperatorAuthority({
    profileId: "viewer",
    scopes: ["operator.sessions.write"],
    permissions: { models: { allow: ["test-provider/test-model"] } },
    assertCurrent: () => {},
  });
  const foreground = createTestFollowupRun({
    provider: "test-provider",
    model: "test-model",
    thinkingCatalog: [{ provider: "test-provider", id: "test-model", input: ["text", "image"] }],
    senderIsOwner: true,
    conversationToolPolicy: { deny: ["read"] },
    toolOverrides: { webSearch: false },
  });
  const maintenance = createSessionMaintenanceFollowup({
    operatorAuthority: original,
    run: foreground.run,
    sessionEntry: { sessionId: "maintenance", updatedAt: 1 },
    sessionKey: "agent:main:maintenance",
    cfg: foreground.run.config,
    provider: "test-provider",
    model: "test-model",
    auth: {},
  });
  const embedded = await buildEmbeddedRunBaseParams({
    run: maintenance.run,
    provider: "test-provider",
    model: "test-model",
    runId: "maintenance-run",
    authProfile: {},
    isReasoningTagProvider: () => {
      throw new Error("Prepared runtime hints must not be rediscovered");
    },
  });
  expect(embedded.modelHasVision).toBe(true);
  expect(embedded.conversationToolPolicy).toEqual({ deny: ["read"] });
  expect(embedded.senderIsOwner).toBe(false);
  expect(embedded.toolOverrides).toBeUndefined();
  expect(embedded.runtimePluginToolGrant).toBeUndefined();
  expect(maintenance.userTurnTranscriptRecorder).toBeUndefined();
  expect(maintenance.operatorAuthority).toBe(original);
  expect(maintenance.operatorAuthority?.permissions?.models?.allow).toEqual([
    "test-provider/test-model",
  ]);
});
