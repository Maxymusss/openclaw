/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { switchChatModel, switchChatThinkingLevel } from "./chat-session.ts";
import { renderChatModelControls } from "./components/chat-model-controls.ts";

const model: ModelCatalogEntry = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai",
  available: true,
  contextWindow: 1_000_000,
  agentRuntime: { id: "openclaw", source: "model" },
  runtimeChoices: [
    { agentRuntime: { id: "codex", source: "model" }, available: true, contextWindow: 200_000 },
  ],
};

function renderRuntimeModel(entry: ModelCatalogEntry, selectedRuntime?: string) {
  const result = createSessionsListResult({ model: entry.id, defaultsModel: entry.id });
  if (selectedRuntime) {
    result.sessions[0]!.agentRuntime = { id: selectedRuntime, source: "session-key" };
  }
  const container = document.createElement("div");
  render(
    renderChatModelControls({
      activeRunId: null,
      connected: true,
      gatewayAvailable: true,
      loading: false,
      modelCatalog: [entry],
      modelSwitching: false,
      sending: false,
      sessionKey: "main",
      selectedSession: result.sessions[0],
      sessionsResult: result,
      stream: null,
    }),
    container,
  );
  return container;
}

describe("chat model runtime choices", () => {
  it("materializes a model selection without requiring a preexisting session ID", async () => {
    const materialized = createSessionsListResult({ model: "selected", modelProvider: "fixture" });
    materialized.sessions[0]!.sessionId = "created-session";
    const host = makeChatHost({
      sessionKey: "main",
      sessionsResult: createSessionsListResult({ omitSessionFromList: true }),
      chatModelSwitchPromises: {},
      requestHandlers: {
        "sessions.patch": {
          ok: true,
          key: "main",
          entry: { sessionId: "created-session", modelOverride: "selected" },
          resolved: { model: "selected", modelProvider: "fixture" },
        },
        "sessions.list": materialized,
      },
    });
    try {
      await expect(switchChatModel(host, "fixture/selected")).resolves.toBe(true);
      expect(host.request).toHaveBeenCalledWith("sessions.patch", {
        key: "main",
        model: "fixture/selected",
      });
      expect(host.sessions.state.result?.sessions[0]).toMatchObject({
        sessionId: "created-session",
        model: "selected",
        modelProvider: "fixture",
      });
    } finally {
      host.sessions.dispose();
    }
  });

  it.each(["unchanged", "replacement", "newer-selection"] as const)(
    "keeps queued model intent bound to its selection after %s",
    async (change) => {
      const sessionKey = "agent:main:selection";
      let result = createSessionsListResult({ model: "original", modelProvider: "fixture" });
      result.sessions[0]!.key = sessionKey;
      result.sessions[0]!.sessionId = "original-session";
      const entered = createDeferred();
      const release = createDeferred();
      const host = makeChatHost({
        sessionKey,
        sessionsResult: result,
        chatModelSwitchPromises: {},
        requestHandlers: {
          "sessions.patch": async (params: { model?: string; thinkingLevel?: string }) => {
            if (params.thinkingLevel) {
              entered.resolve();
              await release.promise;
              return {
                ok: true,
                key: sessionKey,
                entry: { sessionId: "original-session", thinkingLevel: params.thinkingLevel },
              };
            }
            result = {
              ...result,
              sessions: [{ ...result.sessions[0]!, model: params.model, modelProvider: "fixture" }],
            };
            return {
              ok: true,
              key: sessionKey,
              entry: { sessionId: result.sessions[0]!.sessionId, modelOverride: params.model },
              resolved: { model: params.model, modelProvider: "fixture" },
            };
          },
          "sessions.list": () => result,
        },
      });
      const work: Promise<unknown>[] = [];
      const patches = () =>
        host.request.mock.calls.filter(([method]) => method === "sessions.patch");
      try {
        const preceding = switchChatThinkingLevel(host, "high");
        work.push(preceding);
        expect(
          await Promise.race([entered.promise.then(() => true), preceding.then(() => false)]),
        ).toBe(true);
        const selection = switchChatModel(host, "fixture/selected");
        work.push(selection);
        expect(patches()).toHaveLength(1);
        let newer: Promise<boolean> | undefined;
        if (change === "replacement") {
          result = {
            ...result,
            sessions: [{ ...result.sessions[0]!, sessionId: "replacement-session" }],
          };
          host.sessions.reconcile(result.sessions[0]!, result.defaults);
          host.sessionsResult = host.sessions.state.result;
          expect(host.sessionsResult?.sessions[0]?.sessionId).toBe("replacement-session");
        } else if (change === "newer-selection") {
          newer = switchChatModel(host, "fixture/newer");
          work.push(newer);
          expect(patches()).toHaveLength(1);
        }
        release.resolve();
        await preceding;
        await expect(selection).resolves.toBe(change === "unchanged");
        if (newer) {
          await expect(newer).resolves.toBe(true);
        }
        expect(patches().map(([, params]) => params)).toEqual([
          { key: sessionKey, thinkingLevel: "high", expectedSessionId: "original-session" },
          ...(change === "replacement"
            ? []
            : [
                {
                  key: sessionKey,
                  model: change === "newer-selection" ? "fixture/newer" : "fixture/selected",
                  expectedSessionId: "original-session",
                },
              ]),
        ]);
        if (change === "replacement") {
          expect(host.sessions.state.result?.sessions[0]).toMatchObject({
            sessionId: "replacement-session",
            model: "original",
            modelProvider: "fixture",
          });
        }
        expect(host.sessions.state.modelOverrides).not.toHaveProperty(sessionKey);
      } finally {
        release.resolve();
        await Promise.allSettled(work);
        host.sessions.dispose();
      }
    },
  );

  it.each([false, true])(
    "preserves runtime selection when changing only the model (locked: %s)",
    async (runtimeLocked) => {
      const defaultModel: ModelCatalogEntry = {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        agentRuntime: { id: "openclaw", source: "model" },
      };
      const customModel: ModelCatalogEntry = {
        ...model,
        agentRuntime: { id: "custom-harness", source: "model" },
      };
      const models = [defaultModel, customModel];
      const result = createSessionsListResult({
        model: defaultModel.id,
        defaultsModel: defaultModel.id,
        modelOverrideSource: null,
      });
      result.sessions[0]!.agentRuntime = runtimeLocked
        ? { id: "acpx", source: "session-key" }
        : defaultModel.agentRuntime;
      result.sessions[0]!.runtimeSelectionLocked = runtimeLocked || undefined;
      const host = makeChatHost({
        sessionKey: "main",
        sessionsResult: result,
        chatModelCatalog: models,
        chatModelSwitchPromises: {},
        requestHandlers: {
          "sessions.patch": { ok: true, key: "main", path: "", entry: { sessionId: "main" } },
          "sessions.list": result,
        },
      });
      const container = document.createElement("div");
      let selection: Promise<boolean> | undefined;
      const draw = () =>
        render(
          renderChatModelControls({
            activeRunId: null,
            connected: true,
            gatewayAvailable: true,
            loading: false,
            modelCatalog: models,
            modelSwitching: false,
            sending: false,
            sessionKey: "main",
            selectedSession: result.sessions[0],
            sessionsResult: result,
            stream: null,
            onModelSelect: (value, key, runtime) => {
              selection = switchChatModel(host, value, key, runtime);
              return selection;
            },
          }),
          container,
        );
      try {
        draw();
        const rows = container.querySelectorAll<HTMLButtonElement>(
          '[data-chat-model-option="openai/gpt-5.6-sol"]',
        );
        rows[0]!.click();
        await selection;
        expect(host.request).toHaveBeenCalledWith("sessions.patch", {
          key: "main",
          model: "openai/gpt-5.6-sol",
          ...(runtimeLocked ? {} : { agentRuntime: null }),
        });
        expect(
          Array.from(
            rows,
            (row) => row.querySelector(".chat-controls__model-option-name")?.textContent,
          ),
        ).toEqual(runtimeLocked ? ["GPT-5.6 Sol"] : ["GPT-5.6 Sol", "GPT-5.6 Sol"]);
        expect(rows[0]?.getAttribute("data-chat-model-default")).toBeNull();
        expect(rows[0]?.getAttribute("data-chat-model-runtime")).toBe(
          runtimeLocked ? null : "custom-harness",
        );
        result.sessions[0]!.model = customModel.id;
        result.sessions[0]!.modelOverrideSource = "user";
        result.sessions[0]!.agentRuntime = runtimeLocked
          ? { id: "acpx", source: "session-key" }
          : customModel.agentRuntime;
        draw();
        if (runtimeLocked) {
          expect(container.querySelector('[data-chat-model-runtime="codex"]')).toBeNull();
          container.querySelector<HTMLButtonElement>('[data-chat-model-default="true"]')!.click();
          await selection;
          expect(host.request).toHaveBeenCalledWith("sessions.patch", { key: "main", model: null });
          return;
        }
        container.querySelector<HTMLButtonElement>('[data-chat-model-runtime="codex"]')!.click();
        await selection;
        expect(host.request).toHaveBeenCalledWith("sessions.patch", {
          key: "main",
          model: "openai/gpt-5.6-sol",
          agentRuntime: "codex",
        });
        result.sessions[0]!.agentRuntime = { id: "codex", source: "session-key" };
        customModel.runtimeChoices = undefined;
        draw();
        const patchesBeforeReset = host.request.mock.calls.filter(
          ([method]) => method === "sessions.patch",
        ).length;
        container
          .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/gpt-5.6-sol"]')!
          .click();
        await selection;
        const patches = host.request.mock.calls.filter(([method]) => method === "sessions.patch");
        expect(patches).toHaveLength(patchesBeforeReset);
      } finally {
        host.sessions.dispose();
      }
    },
  );

  it.each([undefined, "codex"])(
    "selects exactly one row with absent base runtime metadata and selected runtime %s",
    (selectedRuntime) => {
      const { agentRuntime: _runtime, ...unknownRuntimeModel } = model;
      const container = renderRuntimeModel(
        {
          ...unknownRuntimeModel,
          runtimeChoices: [
            { agentRuntime: { id: "codex", source: "model" }, available: true },
            { agentRuntime: { id: "openclaw", source: "model" }, available: true },
          ],
        },
        selectedRuntime,
      );
      expect(container.querySelectorAll("[data-chat-model-runtime]")).toHaveLength(2);
      expect(
        container.querySelectorAll('[data-chat-model-runtime][aria-selected="true"]'),
      ).toHaveLength(selectedRuntime ? 1 : 0);
      expect(
        container.querySelectorAll('[data-chat-model-option][aria-selected="true"]'),
      ).toHaveLength(1);
    },
  );

  it("uses the selected harness capability for the model trigger", () => {
    const container = renderRuntimeModel(
      {
        ...model,
        supportsTools: true,
        runtimeChoices: [{ ...model.runtimeChoices![0]!, supportsTools: false }],
      },
      "codex",
    );
    expect(
      container.querySelector("[data-chat-model-select]")?.getAttribute("data-chat-model-tools"),
    ).toBe("unavailable");
    expect(
      container.querySelector(".chat-controls__model-capability-badge")?.textContent,
    ).toContain("Chat only");
  });

  it("uses alternate thinking metadata when the base runtime identity is absent", () => {
    const { agentRuntime: _runtime, ...unknownRuntimeModel } = model;
    const container = renderRuntimeModel(
      {
        ...unknownRuntimeModel,
        thinkingLevels: [{ id: "medium", label: "Medium" }],
        thinkingDefault: "medium",
        runtimeChoices: [
          {
            ...model.runtimeChoices![0]!,
            thinkingLevels: [{ id: "high", label: "High" }],
            thinkingDefault: "high",
          },
        ],
      },
      "codex",
    );
    expect(container.querySelector('[data-chat-thinking-option="high"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-thinking-option="medium"]')).toBeNull();
  });

  it.each([
    { name: "an inherited default model", initialRuntime: "openclaw", modelOverrideSource: null },
    { name: "a pinned model", initialRuntime: "openclaw", modelOverrideSource: "user" },
    {
      name: "an effective matching harness without a runtime pin",
      initialRuntime: "codex",
      modelOverrideSource: "user",
    },
  ] as const)(
    "pins the chosen harness for $name and resets through Default",
    async ({ initialRuntime, modelOverrideSource }) => {
      const result = createSessionsListResult({
        model: model.id,
        defaultsModel: model.id,
        modelOverrideSource,
      });
      result.sessions[0]!.agentRuntime = { id: initialRuntime, source: "provider" };
      const host = makeChatHost({
        sessionKey: "main",
        sessionsResult: result,
        chatModelCatalog: [model],
        chatModelSwitchPromises: {},
        requestHandlers: {
          "sessions.patch": { ok: true, key: "main", path: "", entry: { sessionId: "main" } },
          "sessions.list": result,
        },
      });
      const container = document.createElement("div");
      let selection: Promise<boolean> | undefined;
      const draw = () =>
        render(
          renderChatModelControls({
            activeRunId: null,
            connected: true,
            gatewayAvailable: true,
            loading: false,
            modelCatalog: [model],
            modelSwitching: false,
            sending: false,
            sessionKey: "main",
            selectedSession: result.sessions[0],
            sessionsResult: result,
            stream: null,
            onModelSelect: (value, key, runtime) => {
              selection = switchChatModel(host, value, key, runtime);
              return selection;
            },
          }),
          container,
        );
      try {
        draw();
        const rows = () =>
          Array.from(container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"));
        expect(
          rows().map((row) => row.querySelector(".chat-controls__model-option-name")?.textContent),
        ).toEqual(["GPT-5.6 Sol", "GPT-5.6 Sol"]);
        expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(
          initialRuntime === "codex" ? ["false", "true"] : ["true", "false"],
        );
        expect(rows()[0]?.textContent).toContain("1M · OpenClaw");
        expect(rows()[1]?.textContent).toContain("200k · Codex");
        rows()[1]!.click();
        await selection;
        expect(host.request).toHaveBeenCalledWith("sessions.patch", {
          key: "main",
          model: "openai/gpt-5.6-sol",
          agentRuntime: "codex",
        });
        result.sessions[0]!.agentRuntime = { id: "codex", source: "session-key" };
        draw();
        expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true"]);
        const patches = () =>
          host.request.mock.calls.filter(([method]) => method === "sessions.patch");
        expect(patches()).toHaveLength(1);
        rows()[1]!.click();
        await selection;
        expect(patches()).toHaveLength(1);
        rows()[0]!.click();
        await selection;
        expect(host.request).toHaveBeenCalledWith("sessions.patch", {
          key: "main",
          model: null,
          agentRuntime: null,
        });
      } finally {
        host.sessions.dispose();
      }
    },
  );

  it.each(["missing-auth", "cooldown", "unsupported-runtime", "locked"] as const)(
    "preserves the %s guard for additional harness rows",
    (guard) => {
      const onSelect = vi.fn();
      const onSetup = vi.fn();
      const result = createSessionsListResult({ model: model.id, defaultsModel: model.id });
      result.sessions[0]!.agentRuntime = model.agentRuntime;
      const container = document.createElement("div");
      render(
        renderChatModelControls({
          activeRunId: null,
          connected: true,
          gatewayAvailable: true,
          loading: false,
          modelCatalog: [
            {
              ...model,
              runtimeChoices: [
                {
                  ...model.runtimeChoices![0]!,
                  available: false,
                  ...(guard === "locked" ? {} : { unavailableReason: guard }),
                },
              ],
            },
          ],
          modelSelectionLocked: guard === "locked",
          modelSwitching: false,
          sending: false,
          sessionKey: "main",
          selectedSession: result.sessions[0],
          sessionsResult: result,
          stream: null,
          onModelSelect: onSelect,
          onModelSetup: onSetup,
        }),
        container,
      );
      const row = container.querySelector<HTMLButtonElement>('[data-chat-model-runtime="codex"]');
      if (guard === "locked") {
        expect(row).toBeNull();
      } else {
        expect(row?.disabled).toBe(guard === "cooldown" || guard === "unsupported-runtime");
        if (guard === "unsupported-runtime") {
          expect(row?.title).toBe("This harness is unavailable for this model.");
        }
        row?.click();
      }
      expect(onSelect).not.toHaveBeenCalled();
      expect(onSetup).toHaveBeenCalledTimes(guard === "missing-auth" ? 1 : 0);
    },
  );
});
