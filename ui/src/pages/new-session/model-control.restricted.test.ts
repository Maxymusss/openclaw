import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayAgentRow, ModelCatalogResult } from "../../api/types.ts";
import { createGatewayMetadataObserver } from "../../app/gateway-observers.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

const allowed = { id: "allowed", provider: "fixture", name: "Allowed", available: true };
const agent: GatewayAgentRow = { id: "main" };

function fixture() {
  const { context, request } = contextWith([], "openclaw", ["models.list", "sessions.create"]);
  Object.assign(context.gateway.snapshot.hello!, {
    auth: {
      role: "operator",
      scopes: ["operator.sessions.read", "operator.sessions.write"],
      modelRestricted: true,
    },
  });
  let changed = () => {};
  const control = new NewSessionModelControl(() => changed());
  const load = (options: Parameters<NewSessionModelControl["load"]>[3] = {}) => {
    const settled = createDeferred<void>();
    changed = () => {
      if (control.modelSelectionBlockedReason(agent) !== "Loading models…") {
        settled.resolve();
      }
    };
    control.load(context, "main", true, { agent, ...options });
    return settled.promise;
  };
  const draw = () => renderControl(control, context, "main", agent);
  return { context, request, control, load, draw };
}

describe("restricted new-session model selection", () => {
  it("admits an approved URL model only after its authoritative catalog settles", async () => {
    const f = fixture();
    const response = createDeferred<ModelCatalogResult>();
    f.request.mockReturnValue(response.promise);
    const settled = f.load({ initialModel: "fixture/allowed" });
    try {
      expect(f.control.selected).toBe("");
      expect(f.control.hasAvailableModelSelection()).toBe(false);
      response.resolve({ models: [allowed] });
      await settled;
      expect(f.control.selected).toBe("fixture/allowed");
      expect(f.control.hasAvailableModelSelection()).toBe(true);
      expect(f.control.modelSelectionBlockedReason(agent)).toBeUndefined();
      expect(f.draw().querySelector('[data-chat-model-option="fixture/allowed"]')).not.toBeNull();
    } finally {
      response.resolve({ models: [] });
      f.control.reset();
    }
  });

  it("keeps a forbidden URL unavailable and lets an approved explicit choice replace it", async () => {
    const f = fixture();
    f.request.mockResolvedValue({ models: [allowed] });
    try {
      await f.load({ initialModel: "fixture/hidden" });
      expect(f.control.selected).toBe("");
      expect(f.control.hasAvailableModelSelection()).toBe(false);
      expect(f.control.modelSelectionBlockedReason(agent)).toBeDefined();
      expect(f.draw().querySelector('[data-chat-model-option="fixture/hidden"]')).toBeNull();
      const choice = f
        .draw()
        .querySelector<HTMLButtonElement>('[data-chat-model-option="fixture/allowed"]');
      expect(choice).not.toBeNull();
      choice!.click();
      expect(f.control.selected).toBe("fixture/allowed");
      expect(f.control.hasAvailableModelSelection()).toBe(true);
      expect(f.control.modelSelectionBlockedReason(agent)).toBeUndefined();
      f.control.load(f.context, "main", true, { agent, initialModel: "fixture/hidden" });
      expect(f.control.selected).toBe("fixture/allowed");
    } finally {
      f.control.reset();
    }
  });

  it("does not restore a saved model after catalog failure", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("catalog unavailable"));
    try {
      await f.load({ preference: { model: "fixture/hidden", thinkingLevel: "high" } });
      expect(f.control.selected).toBe("");
      expect(f.control.hasAvailableModelSelection()).toBe(false);
      expect(f.control.modelSelectionBlockedReason(agent)).toBeDefined();
      expect(f.draw().querySelector('[data-chat-model-option="fixture/hidden"]')).toBeNull();
    } finally {
      f.control.reset();
    }
  });

  it.each(["handshake", "identity"] as const)(
    "invalidates the selected model across %s changes",
    async (change) => {
      const f = fixture();
      const next = createDeferred<ModelCatalogResult>();
      f.request.mockResolvedValueOnce({ models: [allowed] }).mockReturnValue(next.promise);
      try {
        await f.load({ initialModel: "fixture/allowed" });
        expect(f.control.hasAvailableModelSelection()).toBe(true);
        const previous = { ...f.context.gateway.snapshot };
        if (change === "handshake") {
          Object.assign(f.context.gateway.snapshot, { hello: { ...previous.hello } });
        } else {
          Object.assign(f.context.gateway.snapshot, {
            selfUser: { id: "second-person", name: "Second" },
          });
        }
        createGatewayMetadataObserver(() => true).synchronize(previous, f.context.gateway.snapshot);
        const settled = f.load();
        expect(f.control.selected).toBe("");
        expect(f.control.hasAvailableModelSelection()).toBe(false);
        next.resolve({ models: [{ ...allowed, id: "next", name: "Next" }] });
        await settled;
        const view = f.draw();
        expect(view.querySelector('[data-chat-model-option="fixture/allowed"]')).toBeNull();
        const choice = view.querySelector<HTMLButtonElement>(
          '[data-chat-model-option="fixture/next"]',
        );
        expect(choice).not.toBeNull();
        choice!.click();
        expect(f.control.selected).toBe("fixture/next");
        expect(f.control.hasAvailableModelSelection()).toBe(true);
      } finally {
        next.resolve({ models: [] });
        f.control.reset();
      }
    },
  );
});
