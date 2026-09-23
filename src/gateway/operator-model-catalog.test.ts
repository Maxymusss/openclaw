import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelsListResult } from "../../packages/gateway-protocol/src/schema/model-catalog.js";
import { registerAgentHarness } from "../agents/harness/registry.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { bindModelCatalogRequestBinding } from "./model-catalog-request-binding.js";
import {
  captureOperatorModelCatalogAccess,
  resolveOperatorModelCatalogAgentId,
} from "./operator-model-catalog.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

let registry: ReturnType<typeof captureActivePluginRegistrySnapshot>;
beforeEach(() => {
  registry = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(createEmptyPluginRegistry());
  registerAgentHarness({
    id: "fixture-supported",
    label: "Exact fixture runtime",
    operatorModelPolicySupport: "exact",
    supports: () => ({ supported: true }),
    async runAttempt() {
      throw new Error("Catalog projection must not execute inference");
    },
  });
});
afterEach(() => restoreActivePluginRegistrySnapshot(registry));

function fixture(allow?: string[]) {
  let cfg = rolePolicyConfig();
  cfg.agents = { entries: { main: {}, guest: {} } };
  const role = expectDefined(cfg.gateway?.roles?.definitions.view, "visitor role");
  role.scopes = ["operator.sessions.read"];
  if (allow) {
    role.modelPolicy = { sourceAgent: "main", allow };
  }
  setRuntimeConfigSnapshot(cfg);
  const client = roleClient("view", "catalog-reader");
  client.connect.scopes = ["operator.sessions.read"];
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  return {
    get cfg() {
      return cfg;
    },
    get role() {
      return expectDefined(cfg.gateway?.roles?.definitions.view, "visitor role");
    },
    publish() {
      cfg = structuredClone(cfg);
      setRuntimeConfigSnapshot(cfg);
    },
    client,
    context,
  };
}

function neutralCatalog(): ModelsListResult {
  const catalog: ModelsListResult = {
    models: [
      {
        provider: "fixture",
        id: "allowed",
        name: "Allowed",
        alias: "approved-alias",
        available: true,
        agentRuntime: { id: "fixture-supported", source: "implicit" },
        runtimeChoices: [
          { agentRuntime: { id: "fixture-supported", source: "implicit" }, available: true },
          { agentRuntime: { id: "fixture-unsupported", source: "implicit" }, available: true },
        ],
      },
      {
        provider: "fixture",
        id: "forbidden",
        name: "Hidden model",
        alias: "hidden-alias",
        agentRuntime: { id: "hidden-runtime", source: "implicit" },
      },
      { provider: "hidden-provider", id: "private", name: "Hidden provider model" },
    ],
    decisionModels: [
      { provider: "fixture", id: "allowed", name: "Allowed decision", pluginId: "fixture" },
      { provider: "fixture", id: "forbidden", name: "Hidden decision", pluginId: "fixture" },
    ],
    defaultModels: { automaticUtilityModel: "fixture/forbidden" },
    pendingProviders: ["fixture", "hidden-provider"],
    providerOutcomes: [
      { provider: "fixture", profileId: "private-credential", status: "ready" },
      { provider: "hidden-provider", profileId: "hidden-credential", status: "auth-rejected" },
    ],
    accountSelection: { kind: "shared", label: "Hidden account", authProfileId: "hidden-account" },
  };
  for (const model of catalog.models) {
    bindModelCatalogRequestBinding(model, () => true);
    for (const choice of model.runtimeChoices ?? []) {
      bindModelCatalogRequestBinding(choice, () => true);
    }
  }
  return catalog;
}

describe("caller-local operator catalogs", () => {
  it("requires both physical-route support and an exact runtime while staff keeps the ordinary catalog", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture(["fixture/allowed"]);
      const access = captureOperatorModelCatalogAccess(f);
      const source = neutralCatalog();
      const missingFact = { ...expectDefined(source.models[0], "allowed model") };
      try {
        expect(access.projectCatalog({ models: [missingFact] }).models[0]).toMatchObject({
          available: false,
          unavailableReason: "unsupported-runtime",
        });
        let supported = true;
        const bound = bindModelCatalogRequestBinding({ ...missingFact }, () => supported);
        expect(access.projectCatalog({ models: [bound] }).models[0]?.available).toBe(true);
        supported = false;
        expect(
          access.projectMetadata({ swarmEnabled: false, models: [bound] }).models?.[0],
        ).toMatchObject({ available: false, unavailableReason: "unsupported-runtime" });
        expect(JSON.stringify(bound)).toBe(JSON.stringify(missingFact));
        delete f.role.modelPolicy;
        f.publish();
        const staff = captureOperatorModelCatalogAccess(f);
        try {
          const catalog = { models: [bound] };
          expect(staff.projectCatalog(catalog)).toBe(catalog);
          expect(bound.available).toBe(true);
        } finally {
          staff.release();
        }
      } finally {
        access.release();
      }
    });
  });
  it("leaves omitted unrestricted agent selection to the canonical Gateway resolver", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      f.cfg.agents = { ownership: "explicit", entries: { main: {}, guest: {} } };
      f.role.agents = "*";
      expect(resolveOperatorModelCatalogAgentId(f.client, f.cfg)).toBeUndefined();
      expect(resolveOperatorModelCatalogAgentId(null, f.cfg)).toBeUndefined();
      expect(resolveOperatorModelCatalogAgentId(f.client, f.cfg, "guest")).toBe("guest");
    });
  });

  it("projects the complete response without changing its neutral cached source", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture(["fixture/allowed"]);
      const access = captureOperatorModelCatalogAccess(f);
      const source = neutralCatalog();
      const original = structuredClone(source);
      try {
        expect(access.projectCatalog(source, "fixture/forbidden")).toEqual({
          modelRestricted: true,
          models: [
            {
              ...source.models[0],
              runtimeChoices: [
                { agentRuntime: { id: "fixture-supported", source: "implicit" }, available: true },
                {
                  agentRuntime: { id: "fixture-unsupported", source: "implicit" },
                  available: false,
                  unavailableReason: "unsupported-runtime",
                  unavailableUntil: undefined,
                },
              ],
            },
          ],
          decisionModels: [source.decisionModels?.[0]],
          defaultModels: { automaticUtilityModel: null },
          pendingProviders: ["fixture"],
          providerOutcomes: [{ provider: "fixture", status: "ready" }],
        });
        expect(source).toEqual(original);
        expect(
          access.projectCatalog(
            {
              ...source,
              accountSelection: { kind: "personal", label: "My account", authProfileId: "mine" },
            },
            "fixture/allowed",
          ).accountSelection,
        ).toEqual({ kind: "personal", label: "My account", authProfileId: "mine" });
      } finally {
        access.release();
      }
    });
  });

  it("keeps differently restricted readers separate while preserving omitted ceilings", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture(["fixture/allowed"]);
      const source = neutralCatalog();
      const first = captureOperatorModelCatalogAccess(f);
      f.role.modelPolicy = { sourceAgent: "main", allow: ["fixture/forbidden"] };
      f.publish();
      const second = captureOperatorModelCatalogAccess(f);
      try {
        expect(first.projectCatalog(source).models).toEqual([]);
        expect(second.projectCatalog(source).models.map((model) => model.id)).toEqual([
          "forbidden",
        ]);
        delete f.role.modelPolicy;
        f.publish();
        expect(first.projectCatalog(source).models.map((model) => model.id)).toEqual(["allowed"]);
        expect(second.projectCatalog(source).models.map((model) => model.id)).toEqual([
          "forbidden",
        ]);
        const unrestricted = captureOperatorModelCatalogAccess(f);
        try {
          expect(unrestricted.restricted()).toBe(false);
          expect(unrestricted.projectCatalog(source)).toBe(source);
        } finally {
          unrestricted.release();
        }
      } finally {
        first.release();
        second.release();
      }
    });
  });

  it("retains explicit empty denial across later widening and hides default/account metadata", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture([]);
      const access = captureOperatorModelCatalogAccess(f);
      try {
        f.role.modelPolicy = { sourceAgent: "main", allow: ["fixture/allowed"] };
        f.publish();
        expect(access.projectCatalog(neutralCatalog())).toMatchObject({
          models: [],
          decisionModels: [],
          defaultModels: { automaticUtilityModel: null },
          pendingProviders: [],
          providerOutcomes: [],
        });
        expect(
          access.projectMetadata({
            swarmEnabled: false,
            models: neutralCatalog().models,
            accountSelection: { kind: "shared", label: "Hidden", authProfileId: "hidden" },
          }),
        ).toEqual({ swarmEnabled: false, models: [], modelRestricted: true });
      } finally {
        access.release();
      }
    });
  });

  it("selects only existing allowed agents and never widens a captured finite agent ceiling", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      f.role.agents = ["guest"];
      const access = captureOperatorModelCatalogAccess(f);
      try {
        expect(access.agentIds()).toEqual(["guest"]);
        expect(resolveOperatorModelCatalogAgentId(f.client, f.cfg)).toBe("guest");
        expect(() => resolveOperatorModelCatalogAgentId(f.client, f.cfg, "main")).toThrow(
          "no access to this agent's model catalog",
        );
        f.role.agents = "*";
        expect(access.agentIds()).toEqual(["guest"]);
        expect(access.allowsAgent("main")).toBe(false);
        const fresh = captureOperatorModelCatalogAccess(f);
        try {
          expect(fresh.agentIds()).toEqual(["main", "guest"]);
        } finally {
          fresh.release();
        }
        f.role.agents = [];
        expect(access.agentIds()).toEqual([]);
        expect(() => resolveOperatorModelCatalogAgentId(f.client, f.cfg)).toThrow(
          "no access to this agent's model catalog",
        );
      } finally {
        access.release();
      }
    });
  });

  it("rejects publication after the original connection loses authority", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture(["fixture/allowed"]);
      let current = true;
      const access = captureOperatorModelCatalogAccess({
        ...f,
        hasCurrentClientAuthority: () => current,
      });
      try {
        current = false;
        expect(() => access.projectCatalog(neutralCatalog())).toThrow(
          "Gateway caller authority is no longer active.",
        );
      } finally {
        access.release();
      }
    });
  });
});
