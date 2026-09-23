import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareDecisionProviderReload } from "../decisions/runtime.js";
import type {
  DecisionBatch,
  DecisionProviderV1,
  ProviderDecisionOutcome,
} from "../decisions/types.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createRuntimePluginManifestLookup } from "../plugins/active-runtime-registry.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshotState,
} from "../plugins/current-plugin-metadata-state.js";
import { runPluginRegisterSyncInRegistry } from "../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-selection.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.js";
import { createOpenClawCodingTools, createOpenClawCodingToolsInternal } from "./agent-tools.js";
import { isDecisionAssistanceEligible } from "./decision-assistance.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  OperatorModelPolicyError,
  runWithOperatorModelAuthority,
  runWithOperatorModelRequest,
} from "./operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const batch: DecisionBatch = {
  state: { message: "Please refund this order." },
  questions: {
    refund: {
      type: "boolean",
      instructions: { question: "Is a refund requested?" },
      criteria: { true: "Money back", false: "No money back" },
    },
    route: { type: "choice", criteria: { billing: ["Refunds", "Payments"], other: null } },
    urgency: { type: "score", criteria: ["Routine", { anchor: "Soon" }, "Immediate"] },
  },
};
const answer = {
  status: "ok",
  result: {
    model: "fixture-reported-model",
    answers: {
      refund: { type: "boolean", probabilityTrue: 0.947 },
      route: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.51, other: 0.48 },
        confidence: 0.03,
      },
      urgency: { type: "score", score: 1.14, probabilities: [0.02, 0.82, 0.16], confidence: 0.74 },
    },
    usage: { inputTokens: 12 },
  },
} satisfies ProviderDecisionOutcome;
const config: OpenClawConfig = {
  agents: {
    defaults: {
      decisionModel: "fixture/default",
    },
    entries: {
      main: { default: true },
      alternate: { decisionModel: "fixture/override" },
      disabled: { decisionModel: "" },
    },
  },
};

// Exercise core assembly, the real Decision runtime, and registered provider admission together.
function fixture(
  evaluate: DecisionProviderV1["evaluate"] = async () => answer,
  isReady?: () => boolean,
) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "decision-fixture",
    source: "/synthetic/index.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { decisionProviders: ["fixture"] },
  });
  const api = builder.createApi(record, { config });
  runPluginRegisterSyncInRegistry(
    (registration) =>
      registration.registerDecisionProvider({
        id: "fixture",
        contractVersion: 1,
        evaluate,
        isReady,
      }),
    api,
    builder.registry,
    record.id,
  );
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  setRuntimeConfigSnapshot(config);
  onTestFinished(async () => {
    prepareDecisionProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
  });
  return { ...builder, api, record };
}

// Disable unrelated plugin tool discovery; the core factory and wrappers remain real.
function assembled(agentId = "main", cfg = config) {
  return createOpenClawTools({
    config: cfg,
    agentSessionKey: `agent:${agentId}:main`,
    disablePluginTools: true,
    disableMessageTool: true,
    wrapBeforeToolCallHook: false,
  }).find((tool) => tool.name === "decision_evaluate");
}
function requiredTool(agentId = "main") {
  const tool = assembled(agentId);
  if (!tool) {
    throw new Error("decision_evaluate was not assembled");
  }
  return tool;
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  clearCurrentPluginMetadataSnapshot();
});

describe("core decision_evaluate registered flow", () => {
  it.each(["model", "foreground"] as const)(
    "refuses a retained staff tool in a request-only %s scope",
    async (restriction) => {
      const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
      const isReady = vi.fn(() => true);
      fixture(evaluate, isReady);
      const staff = createAdmittedRunOperatorAuthority({
        profileId: "staff",
        scopes: ["operator.admin"],
        assertCurrent: () => {},
      });
      const retained = runWithOperatorModelRequest(staff, () => requiredTool());
      const release = vi.fn();
      const retain = vi.fn(() => release);
      const guest = createAdmittedRunOperatorAuthority({
        profileId: "guest",
        scopes: ["operator.read"],
        retain,
        ...(restriction === "model"
          ? { permissions: { models: { allow: ["fixture/default"] } } }
          : { executionPolicy: "foreground-only" as const }),
        assertCurrent: () => {},
      });
      const client = createOperatorClient({ profileId: "guest", scopes: ["operator.read"] });
      client.internal = { operatorRunAuthority: guest };
      const work = new AsyncWorkScope();
      try {
        await expect(
          work.run(() =>
            withPluginRuntimeGatewayRequestScope(
              {
                client,
                context: createContext(),
                isWebchatConnect: () => false,
              },
              () => retained.execute("request-only", batch),
            ),
          ),
        ).rejects.toBeInstanceOf(OperatorModelPolicyError);
      } finally {
        await work.drain();
      }
      expect(retain).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(isReady).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
      expect((await retained.execute("staff", batch)).details).toMatchObject({ status: "ok" });
      expect(evaluate).toHaveBeenCalledOnce();
    },
  );

  it("does not replace ambient model authority in sibling plugin factories", async () => {
    const builder = fixture();
    const selected: OpenClawConfig = {
      ...config,
      plugins: { enabled: true, allow: [builder.record.id] },
      tools: { allow: ["decision_evaluate", "decision_source_probe"] },
    };
    const artifact = {
      source: builder.record.source,
      rootDir: "/synthetic",
      origin: builder.record.origin,
      preferBuiltPluginArtifacts: false,
    };
    builder.record.contracts = {
      ...builder.record.contracts,
      tools: ["decision_source_probe"],
    };
    bindPluginRuntimeArtifactSelection(builder.record, {
      preferBuiltPluginArtifacts: false,
      runtimeEntry: resolvePluginRuntimeArtifactSelection({ ...artifact, entryKind: "runtime" }),
    });
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: builder.record.id, ...artifact, contracts: builder.record.contracts }],
    });
    setCurrentPluginMetadataSnapshotState(
      snapshot,
      undefined,
      undefined,
      undefined,
      undefined,
      "gateway",
    );
    setRuntimeConfigSnapshot(selected);
    const guest = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.sessions.write"],
      permissions: { models: { allow: [] } },
      assertCurrent: () => {},
    });
    const staff = createAdmittedRunOperatorAuthority({
      profileId: "staff",
      scopes: ["operator.admin"],
      assertCurrent: () => {},
    });
    let observed: typeof guest | undefined;
    const factory = vi.fn(() => {
      observed = runWithOperatorModelRequest(undefined, (original) => original);
      return null;
    });
    runPluginRegisterSyncInRegistry(
      (api) => api.registerTool(factory, { names: ["decision_source_probe"] }),
      builder.api,
      builder.registry,
      builder.record.id,
    );
    expect(builder.registry.diagnostics).toEqual([]);
    expect(builder.registry.tools).toContainEqual(
      expect.objectContaining({
        pluginId: builder.record.id,
        names: ["decision_source_probe"],
      }),
    );
    expect(
      createRuntimePluginManifestLookup(builder.registry, snapshot.plugins)(builder.record.id),
    ).toBe(builder.record);
    await runWithOperatorModelAuthority(guest, async () => {
      const tools = createOpenClawCodingToolsInternal(
        {
          config: selected,
          sessionKey: "agent:main:main",
        },
        undefined,
        staff,
      );
      expect(tools.map((tool) => tool.name)).not.toContain("decision_evaluate");
      expect(factory).toHaveBeenCalledOnce();
      expect(observed).toBe(guest);
    });
  });

  it.each(["model", "foreground"] as const)(
    "omits the tool under %s restrictions and refuses a retained staff tool in that scope",
    async (restriction) => {
      const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
      const isReady = vi.fn(() => true);
      fixture(evaluate, isReady);
      const staff = createAdmittedRunOperatorAuthority({
        profileId: "staff",
        scopes: ["operator.admin"],
        assertCurrent: () => {},
      });
      const retained = runWithOperatorModelRequest(staff, () => requiredTool());
      const guest = createAdmittedRunOperatorAuthority({
        profileId: "guest",
        scopes: ["operator.sessions.write"],
        ...(restriction === "model"
          ? { permissions: { models: { allow: ["fixture/default"] } } }
          : { executionPolicy: "foreground-only" as const }),
        assertCurrent: () => {},
      });
      await runWithOperatorModelAuthority(guest, async () => {
        expect(assembled()).toBeUndefined();
        expect(
          createOpenClawCodingTools({
            config: { ...config, tools: { allow: ["decision_evaluate"] } },
            sessionKey: "agent:main:main",
          }).map((tool) => tool.name),
        ).not.toContain("decision_evaluate");
        await expect(retained.execute("nested", batch)).rejects.toBeInstanceOf(
          OperatorModelPolicyError,
        );
      });
      expect(isReady).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
      expect((await retained.execute("staff", batch)).details).toMatchObject({ status: "ok" });
      expect(evaluate).toHaveBeenCalledOnce();
    },
  );

  it("retains the tool source across later unrestricted callers and lazy runtime loading", async () => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    const isReady = vi.fn(() => true);
    fixture(evaluate, isReady);
    const abort = new AbortController();
    const cancellation = new Error("original tool source revoked");
    const source = createAdmittedRunOperatorAuthority({
      profileId: "original",
      scopes: ["operator.sessions.write"],
      signal: abort.signal,
      assertCurrent: () => {},
    });
    const retained = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operatorAuthority: source,
      },
      () => requiredTool(),
    );
    abort.abort(cancellation);
    await expect(retained.execute("later", batch)).rejects.toMatchObject({
      code: "OPERATOR_MODEL_POLICY_DENIED",
      cause: cancellation,
    });
    expect(isReady).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("keeps the explicit tool independent of automatic eligibility through Labs on/off transitions", async () => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    fixture(evaluate);
    const retained = requiredTool("alternate");
    for (const decisionAssistance of [false, true, false]) {
      const current: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          defaults: { ...config.agents!.defaults, experimental: { decisionAssistance } },
        },
      };
      setRuntimeConfigSnapshot(current);
      evaluate.mockClear();
      expect(isDecisionAssistanceEligible(current, "main")).toBe(decisionAssistance);
      expect(isDecisionAssistanceEligible(current, "alternate")).toBe(decisionAssistance);
      expect(isDecisionAssistanceEligible(current, "disabled")).toBe(false);
      expect(assembled("disabled", current)).toBeUndefined();
      const fresh = assembled("main", current)!;
      expect(fresh).toBeDefined();
      expect(evaluate).not.toHaveBeenCalled();
      expect((await fresh.execute("fresh", batch)).details).toMatchObject({ status: "ok" });
      expect(evaluate).toHaveBeenLastCalledWith(
        batch,
        expect.objectContaining({ agentId: "main", model: "default" }),
      );
      expect((await retained.execute("retained", batch)).details).toMatchObject({ status: "ok" });
      expect(evaluate).toHaveBeenLastCalledWith(
        batch,
        expect.objectContaining({ agentId: "alternate", model: "override" }),
      );
      expect(evaluate).toHaveBeenCalledTimes(2);
    }
  });

  it("requires effective selection without provider-health churn", () => {
    expect(assembled()).toBeDefined();
    expect(assembled("alternate")).toBeDefined();
    expect(assembled("disabled")).toBeUndefined();
    expect(
      assembled("main", {
        agents: {
          defaults: { decisionModel: "fixture/default" },
          entries: { main: {} },
        },
      }),
    ).toBeDefined();
    expect(
      assembled("main", {
        agents: {
          defaults: {},
          entries: { main: {} },
        },
      }),
    ).toBeUndefined();
    expect(
      assembled("main", {
        agents: {
          defaults: {
            decisionModel: "fixture/default",
          },
          entries: { main: { decisionModel: "" } },
        },
      }),
    ).toBeUndefined();
    fixture(
      async () => answer,
      () => false,
    );
    expect(assembled()).toBeDefined();
  });

  it("preserves all answer values, structured evidence, trusted binding and provenance", async () => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    fixture(evaluate);
    const result = await requiredTool("alternate").execute("call", batch);
    expect(result.details).toEqual({
      ...answer,
      provenance: {
        providerId: "fixture",
        rubricVersion: expect.stringMatching(/^decision-v1-[0-9a-f]{24}$/),
        runtimeGeneration: expect.any(String),
      },
    });
    expect(evaluate).toHaveBeenCalledWith(
      batch,
      expect.objectContaining({ agentId: "alternate", model: "override" }),
    );
    expect(JSON.parse(result.content.find((entry) => entry.type === "text")!.text)).toEqual(
      result.details,
    );
  });

  it("identifies the whole rubric, ignoring object key order and evidence changes", async () => {
    fixture();
    const tool = requiredTool();
    const run = async (input: DecisionBatch) => (await tool.execute("call", input)).details;
    const first = await run(batch);
    expect(
      await run({
        ...batch,
        state: "different evidence",
        questions: {
          urgency: batch.questions.urgency!,
          route: batch.questions.route!,
          refund: batch.questions.refund!,
        },
      }),
    ).toEqual(first);
    expect(
      await run({
        ...batch,
        questions: {
          ...batch.questions,
          refund: { ...batch.questions.refund!, instructions: { question: "Different meaning" } },
        },
      }),
    ).not.toEqual(first);
  });

  it("rechecks selection on a retained tool without mutating its definition", async () => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    fixture(evaluate);
    const tool = requiredTool();
    const description = tool.description;
    setRuntimeConfigSnapshot({
      agents: {
        defaults: {
          decisionModel: "fixture/reconfigured",
        },
      },
    });
    await tool.execute("call", batch);
    expect(evaluate).toHaveBeenLastCalledWith(
      batch,
      expect.objectContaining({ model: "reconfigured", agentId: "main" }),
    );
    setRuntimeConfigSnapshot({
      agents: {
        defaults: {
          decisionModel: "fixture/default",
        },
        entries: { main: { decisionModel: "" } },
      },
    });
    expect((await tool.execute("call", batch)).details).toMatchObject({
      status: "unavailable",
      reason: "disabled",
      guidance: expect.any(String),
    });
    expect(evaluate).toHaveBeenCalledOnce();
    setRuntimeConfigSnapshot(config);
    const retained = requiredTool();
    setRuntimeConfigSnapshot({
      agents: {
        defaults: { decisionModel: "fixture/default" },
      },
    });
    expect((await retained.execute("call", batch)).details).toMatchObject({ status: "ok" });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(assembled()).toBeDefined();
    expect(tool.description).toBe(description);
  });

  it("honors normal allow policy and explicit denial in the full coding tool factory", () => {
    fixture();
    const selected = { ...config, tools: { allow: ["decision_evaluate"] } };
    expect(
      createOpenClawCodingTools({ config: selected, sessionKey: "agent:main:main" }).map(
        (tool) => tool.name,
      ),
    ).toContain("decision_evaluate");
    const denied = { ...selected, tools: { ...selected.tools, deny: ["decision_evaluate"] } };
    expect(
      createOpenClawCodingTools({ config: denied, sessionKey: "agent:main:main" }).map(
        (tool) => tool.name,
      ),
    ).not.toContain("decision_evaluate");
  });

  it("rejects resource bounds before rubric hashing or provider execution", async () => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    fixture(evaluate);
    const tool = requiredTool();
    let nested: unknown = "private evidence";
    for (let depth = 0; depth < 10000; depth++) {
      nested = { child: nested };
    }
    for (const input of [
      { state: null, questions: { q: { type: "boolean", instructions: nested } } },
      { state: "x".repeat(1_048_577), questions: { q: { type: "boolean" } } },
      {
        state: null,
        questions: Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [String(index), { type: "boolean" }]),
        ),
      },
    ]) {
      const result = await tool.execute("bounded", input);
      expect(result.details).toMatchObject({
        status: "unavailable",
        reason: "unsupported-input",
        guidance: expect.stringContaining("Host bounds"),
      });
      expect(JSON.stringify(result)).not.toContain("private evidence");
    }
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("does not report obsolete provider capabilities on host rejection", async () => {
    setRuntimeConfigSnapshot(config);
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "decision-fixture",
          contracts: { decisionProviders: ["fixture"] },
          decisionModels: [
            {
              provider: "fixture",
              id: "default",
              name: "Fixture",
              capabilities: {
                questionTypes: ["boolean", "choice", "score"],
                maxQuestions: 99,
              },
            },
          ],
        },
      ],
    });
    setCurrentPluginMetadataSnapshotState(
      snapshot,
      undefined,
      undefined,
      undefined,
      undefined,
      "gateway",
    );
    const tool = requiredTool();
    expect(tool.description).toContain("at most 99 questions");
    setRuntimeConfigSnapshot({
      agents: {
        defaults: {
          decisionModel: "fixture/reconfigured",
        },
      },
    });
    const result = await tool.execute("call", {
      state: "x".repeat(1_048_577),
      questions: { q: { type: "boolean" } },
    });
    expect(result.details).toMatchObject({
      status: "unavailable",
      reason: "unsupported-input",
      guidance: expect.stringContaining("Host bounds"),
    });
    expect(JSON.stringify(result)).not.toContain("at most 99 questions");
  });

  it.each([
    { ...batch, agentId: "disabled" },
    { ...batch, model: "another/provider" },
    {
      state: "private evidence",
      questions: { q: { type: "boolean", criteria: { maybe: "unknown" } } },
    },
  ])("rejects malformed or routing arguments without echoing evidence", async (input) => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    fixture(evaluate);
    await expect(requiredTool().execute("call", input)).rejects.toThrow("no evidence was sent");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    "rate-limited",
    "transport",
    "unsupported-input",
    "invalid-response",
    "authentication",
  ] as const)("keeps the tool stable and returns actionable %s", async (reason) => {
    fixture(async () => ({ status: "unavailable", reason }));
    const tool = requiredTool();
    expect((await tool.execute("call", batch)).details).toMatchObject({
      status: "unavailable",
      reason,
      guidance: expect.any(String),
    });
    expect(assembled()?.description).toBe(tool.description);
  });

  it("reports missing provider configuration without changing eligibility", async () => {
    setRuntimeConfigSnapshot(config);
    expect((await requiredTool().execute("call", batch)).details).toMatchObject({
      status: "unavailable",
      reason: "not-configured",
      guidance: expect.stringContaining("configure"),
    });
    expect(assembled()).toBeDefined();
  });

  it("returns credential unavailability without dispatching or removing the tool", async () => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    fixture(evaluate, () => false);
    expect((await requiredTool().execute("call", batch)).details).toMatchObject({
      status: "unavailable",
      reason: "credentials-unavailable",
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(assembled()).toBeDefined();
  });

  it("propagates caller cancellation before and during provider work", async () => {
    const cancellation = new Error("caller cancelled");
    const entered = createDeferredCore();
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async (_batch, context) => {
      entered.resolve();
      return await new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(cancellation), {
          once: true,
        });
      });
    });
    fixture(evaluate);
    const tool = requiredTool();
    const aborted = AbortSignal.abort(cancellation);
    await expect(tool.execute("before", batch, aborted)).rejects.toThrow("caller cancelled");
    expect(evaluate).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = tool.execute("during", batch, controller.signal);
    const rejection = expect(pending).rejects.toThrow("caller cancelled");
    await entered.promise;
    controller.abort(cancellation);
    await rejection;
  });
});
