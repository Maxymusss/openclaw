import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayAgentRow, ModelCatalogResult } from "../../api/types.ts";
import { createGatewayMetadataObserver } from "../../app/gateway-observers.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";
import {
  loadNewSessionPreference,
  replaceBrowserPreference,
  type NewSessionPreference,
} from "./preferences.ts";

const allowed = { id: "allowed", provider: "fixture", name: "Allowed", available: true };
const agent: GatewayAgentRow = { id: "main" };

function fixture(onSelectionChange?: ConstructorParameters<typeof NewSessionModelControl>[1]) {
  const { context, request, emitCatalogChanged } = contextWith([], "openclaw", [
    "models.list",
    "sessions.create",
  ]);
  Object.assign(context.gateway.snapshot.hello!, {
    auth: {
      role: "operator",
      scopes: ["operator.sessions.read", "operator.sessions.write"],
      modelRestricted: true,
    },
  });
  let changed = () => {};
  const control = new NewSessionModelControl(() => changed(), onSelectionChange);
  const load = (options: Parameters<NewSessionModelControl["load"]>[3] = {}) => {
    const settled = createDeferred();
    changed = () => {
      if (control.modelSelectionBlockedReason(agent) !== "Loading models…") {
        settled.resolve();
      }
    };
    control.load(context, "main", true, { agent, ...options });
    return settled.promise;
  };
  const draw = () => renderControl(control, context, "main", agent);
  return { context, request, control, load, draw, emitCatalogChanged };
}

describe("restricted new-session model selection", () => {
  it.each([false, true])(
    "preserves hidden saved intent until an explicit allowed choice: %s",
    async (chooseAllowed) => {
      const gatewayUrl = `https://model-preference-${chooseAllowed}.example.test`;
      const preference = { model: "fixture/hidden", thinkingLevel: "high" };
      const hidden: ModelCatalogResult["models"][number] = {
        ...allowed,
        id: "hidden",
        name: "Remembered",
        reasoning: true,
        thinkingLevels: [{ id: "high", label: "High" }],
      };
      const onSelectionChange = vi.fn((selection: NewSessionPreference) => {
        expect(replaceBrowserPreference(gatewayUrl, "main", selection)).toBe(true);
      });
      const f = fixture(onSelectionChange);
      const hello = f.context.gateway.snapshot.hello;
      const client = f.context.gateway.snapshot.client;
      expect(replaceBrowserPreference(gatewayUrl, "main", preference)).toBe(true);
      f.request.mockResolvedValue({ models: [allowed, hidden] });
      try {
        await f.load({ preference: loadNewSessionPreference(gatewayUrl, "main") });
        expect(f.control.selected).toBe(preference.model);
        expect(f.control.thinkingLevel).toBe(preference.thinkingLevel);
        expect(onSelectionChange).not.toHaveBeenCalled();

        f.request.mockResolvedValue({ models: [allowed], modelRestricted: true });
        f.emitCatalogChanged();
        await vi.waitFor(() => expect(f.control.selected).toBe(""));
        expect(f.control.hasAvailableModelSelection()).toBe(false);
        expect(f.draw().querySelector('[data-chat-model-option="fixture/hidden"]')).toBeNull();
        expect(onSelectionChange).not.toHaveBeenCalled();
        expect(loadNewSessionPreference(gatewayUrl, "main")).toEqual(preference);

        if (chooseAllowed) {
          const choice = f
            .draw()
            .querySelector<HTMLButtonElement>('[data-chat-model-option="fixture/allowed"]');
          expect(choice).not.toBeNull();
          choice!.click();
          expect(onSelectionChange).toHaveBeenCalledOnce();
          expect(loadNewSessionPreference(gatewayUrl, "main")).toEqual({
            model: "fixture/allowed",
          });
          f.control.load(f.context, "main", true, {
            agent,
            preference: loadNewSessionPreference(gatewayUrl, "main"),
          });
        }

        f.request.mockResolvedValue({ models: [allowed, hidden] });
        f.emitCatalogChanged();
        await vi.waitFor(() =>
          expect(
            f.draw().querySelector('[data-chat-model-option="fixture/hidden"]'),
          ).not.toBeNull(),
        );
        expect(f.control.selected).toBe(chooseAllowed ? "fixture/allowed" : preference.model);
        expect(f.control.thinkingLevel).toBe(chooseAllowed ? "" : preference.thinkingLevel);
        expect(onSelectionChange).toHaveBeenCalledTimes(chooseAllowed ? 1 : 0);
        expect(loadNewSessionPreference(gatewayUrl, "main")).toEqual(
          chooseAllowed ? { model: "fixture/allowed" } : preference,
        );
        expect(f.context.gateway.snapshot.hello).toBe(hello);
        expect(f.context.gateway.snapshot.client).toBe(client);
      } finally {
        f.control.reset();
        replaceBrowserPreference(gatewayUrl, "main", {});
      }
    },
  );

  it.each([{ available: false }, { manualSelectionAllowed: false }])(
    "still repairs a saved model when the restricted catalog explicitly rejects it: %j",
    async (unavailable) => {
      const onSelectionChange = vi.fn();
      const f = fixture(onSelectionChange);
      f.request.mockResolvedValue({
        models: [{ ...allowed, ...unavailable }],
        modelRestricted: true,
      });
      try {
        await f.load({ preference: { model: "fixture/allowed", thinkingLevel: "high" } });
        expect(f.control.selected).toBe("");
        expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
          model: "",
          thinkingLevel: "",
          fastMode: undefined,
        });
      } finally {
        f.control.reset();
      }
    },
  );

  it.each([false, true])(
    "uses same-connection catalog changes with initial hello restriction %s",
    async (helloRestricted) => {
      const f = fixture();
      if (!helloRestricted) {
        delete f.context.gateway.snapshot.hello!.auth!.modelRestricted;
      }
      const hello = f.context.gateway.snapshot.hello;
      const client = f.context.gateway.snapshot.client;
      f.request.mockResolvedValue({ models: [allowed] });
      try {
        await f.load({ initialModel: "fixture/hidden" });
        expect(f.control.selected).toBe("fixture/hidden");
        f.request.mockResolvedValue({ models: [allowed], modelRestricted: true });
        f.emitCatalogChanged();
        await vi.waitFor(() => expect(f.control.selected).toBe(""));
        expect(f.draw().querySelector('[data-chat-model-option="fixture/hidden"]')).toBeNull();
        f.request.mockResolvedValue({ models: [allowed] });
        const before = f.request.mock.calls.length;
        f.emitCatalogChanged();
        await vi.waitFor(() => expect(f.request.mock.calls.length).toBeGreaterThan(before));
        f.control.selected = "fixture/hidden";
        await vi.waitFor(() =>
          expect(
            f.draw().querySelector('[data-chat-model-option="fixture/hidden"]'),
          ).not.toBeNull(),
        );
        expect(f.context.gateway.snapshot.hello).toBe(hello);
        expect(f.context.gateway.snapshot.client).toBe(client);
        // The accepted omission wins over the unchanged restricted hello.
        expect(f.control.modelSelectionBlockedReason(agent)).toBeUndefined();
      } finally {
        f.control.reset();
      }
    },
  );

  it("admits an approved URL model only after its authoritative catalog settles", async () => {
    const f = fixture();
    const response = createDeferred<ModelCatalogResult>();
    f.request.mockReturnValue(response.promise);
    const settled = f.load({ initialModel: "fixture/allowed" });
    try {
      expect(f.control.selected).toBe("");
      expect(f.control.hasAvailableModelSelection()).toBe(false);
      response.resolve({ models: [allowed], modelRestricted: true });
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
    f.request.mockResolvedValue({ models: [allowed], modelRestricted: true });
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
      f.request
        .mockResolvedValueOnce({ models: [allowed], modelRestricted: true })
        .mockReturnValue(next.promise);
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
        next.resolve({ models: [{ ...allowed, id: "next", name: "Next" }], modelRestricted: true });
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
