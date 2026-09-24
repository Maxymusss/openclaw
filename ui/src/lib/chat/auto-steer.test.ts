// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createInitialConfigState } from "../config/config-state-model.ts";
import { isChatAutoSteerAvailable } from "./auto-steer.ts";
import { normalizeStoredQueueItem, sameQueuedDeliveryVersion } from "./outbox-store-codec.ts";

describe("Auto presentation eligibility", () => {
  const config = {
    agents: {
      defaults: {
        experimental: { decisionAssistance: true },
        decisionModel: "typesafe/jev-latest",
      },
      entries: { disabled: { decisionModel: "" }, alternate: { decisionModel: "typesafe/other" } },
    },
  };
  const state = () => ({
    ...createInitialConfigState({ phase: "connected" }),
    configSnapshot: { runtimeConfig: config },
  });
  it("requires the live Lab and effective owning agent selection, not a staged form", () => {
    expect(isChatAutoSteerAvailable(state(), "main")).toBe(true);
    expect(isChatAutoSteerAvailable(state(), "disabled")).toBe(false);
    expect(isChatAutoSteerAvailable(state(), "alternate")).toBe(true);
    expect(isChatAutoSteerAvailable(state(), undefined)).toBe(false);
    expect(
      isChatAutoSteerAvailable({ ...state(), configSnapshot: null, configForm: config }, "main"),
    ).toBe(false);
    for (const decisionAssistance of [undefined, false]) {
      expect(
        isChatAutoSteerAvailable(
          {
            ...state(),
            configSnapshot: {
              runtimeConfig: {
                agents: {
                  defaults: {
                    decisionModel: "typesafe/jev-latest",
                    experimental: { decisionAssistance },
                  },
                },
              },
            },
          },
          "main",
        ),
      ).toBe(false);
    }
    for (const flags of [
      { connected: false },
      { configLoading: true },
      { configNeedsApply: true },
      { lastError: "offline" },
    ]) {
      expect(isChatAutoSteerAvailable({ ...state(), ...flags }, "main")).toBe(false);
    }
  });
});

describe("durable Auto intent", () => {
  it.each([undefined, "steer", "followup", "collect"] as const)(
    "round trips independently of baseline %s",
    (queueMode) => {
      const row = {
        id: "input-a",
        text: "Use the existing account",
        createdAt: 1,
        deliveryPolicy: "auto" as const,
        queueMode,
        sendRunId: "run-a",
        sendState: "failed" as const,
        sendRejectedBeforeCustody: true as const,
      };
      // Exercise the durable JSON wire format, not an in-memory deep clone.
      const serialized = JSON.stringify(row);
      const restored = normalizeStoredQueueItem(JSON.parse(serialized));
      expect(restored?.deliveryPolicy).toBe("auto");
      expect(restored?.queueMode).toBe(queueMode);
      expect(restored?.sendRunId).toBe("run-a");
      expect(restored?.sendRejectedBeforeCustody).toBe(true);
      expect(
        normalizeStoredQueueItem({ ...row, sendState: "unconfirmed" })?.sendRejectedBeforeCustody,
      ).toBeUndefined();
      expect(sameQueuedDeliveryVersion(row, { ...row })).toBe(true);
      expect(sameQueuedDeliveryVersion(row, { ...row, deliveryPolicy: undefined })).toBe(false);
      expect(sameQueuedDeliveryVersion(row, { ...row, queueMode: "interrupt" })).toBe(false);
    },
  );
});
