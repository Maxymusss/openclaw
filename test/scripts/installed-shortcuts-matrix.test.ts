import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import {
  createInstalledCommandRunner,
  type InstalledCommandDiagnostic,
} from "../../scripts/test-ios-shortcuts-installed.mts";

vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: vi.fn(),
}));
vi.mock("../../extensions/qa-lab/api.js", () => ({ startQaMockOpenAiServer: vi.fn() }));
vi.mock("../e2e/qa-lab/runtime/cloud-worker-midturn-loss-fixture.js", () => ({
  MODEL_REF: "fixture/model",
  PROOF_TIMEOUT_MS: 30_000,
}));
vi.mock("../e2e/qa-lab/runtime/profile-binding-wire-fixture.js", () => ({
  runProfileWireProof: vi.fn(),
}));
vi.mock("../e2e/qa-lab/runtime/skill-library-wire-fixture.js", () => ({
  SKILL_LIBRARY_ALICE: "alice@example.invalid",
  SKILL_LIBRARY_WRITER_SCOPES: [],
}));
import {
  assertInstalledExplicitObservation,
  assertInstalledIntentRegistration,
  assertInstalledObservation,
  createInstalledShortcutsMatrix,
  installedAutomaticCases,
  readInstalledObservation,
  type InstalledObservation,
} from "../../scripts/lib/installed-shortcuts-matrix.mts";
import type {
  ProfileWireFixture,
  ProfileWireProvider,
} from "../e2e/qa-lab/runtime/profile-binding-wire-fixture.js";
import type { startQaGatewayRpcProxy } from "../fixtures/qa-gateway-rpc-proxy.mjs";
import { createDeferred } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

const baseline: InstalledObservation = {
  producers: 0,
  prepared: 0,
  automaticEntries: 0,
  automaticCompletions: 0,
  explicitEntries: 0,
  explicitCompletions: 0,
  kind: "none",
  automaticOutcome: "none",
  explicitOutcome: "none",
  parameterMatch: false,
  misattributed: false,
  idleUnprotectedComposer: true,
};
function completed(
  id: (typeof installedAutomaticCases)[number],
  downstream = false,
): InstalledObservation {
  const automatic = !id.endsWith("-off");
  return {
    ...baseline,
    producers: 1,
    prepared: 1,
    kind: id.startsWith("send") ? "send" : "inspect",
    automaticEntries: Number(automatic),
    automaticCompletions: Number(automatic),
    parameterMatch: automatic,
    automaticOutcome: automatic
      ? id === "send-away" || id === "send-aba"
        ? "skipped"
        : "opened"
      : "none",
    explicitEntries: Number(downstream),
    explicitCompletions: Number(downstream),
    explicitOutcome: downstream ? "opened" : "none",
    ...(downstream && id !== "send-off" ? { runMatch: true } : {}),
  };
}

describe("installed Shortcuts owner result accounting", () => {
  it.each(installedAutomaticCases)("requires the complete %s boundary", (id) => {
    expect(() => assertInstalledObservation(id, baseline, completed(id), false)).not.toThrow();
    expect(() => assertInstalledObservation(id, baseline, completed(id, true), true)).not.toThrow();
    for (const patch of [
      { prepared: 0 },
      { producers: 2 },
      { automaticEntries: 2 },
      { automaticCompletions: 2 },
      { explicitEntries: 2 },
      { explicitCompletions: 0 },
      { explicitOutcome: "cancelled" },
      { misattributed: true },
      { runMatch: false },
      { idleUnprotectedComposer: false },
    ]) {
      expect(() =>
        assertInstalledObservation(id, baseline, { ...completed(id, true), ...patch }, true),
      ).toThrow();
    }
  });

  it.each(["send-away", "send-aba"] as const)(
    "requires an unprotected idle composer after %s skips",
    (id) => {
      expect(() =>
        assertInstalledObservation(
          id,
          baseline,
          { ...completed(id), idleUnprotectedComposer: false },
          false,
        ),
      ).toThrow("Composer protection");
    },
  );

  it("does not turn OFF's unobserved Run into an observer equality claim", () => {
    expect(() =>
      assertInstalledObservation(
        "send-off",
        baseline,
        { ...completed("send-off", true), runMatch: true },
        true,
      ),
    ).toThrow();
  });

  it("requires a successful ordinary entry, not completion or automatic delivery alone", () => {
    const before = completed("send-aba", true);
    const after = { ...before, explicitEntries: 2, explicitCompletions: 2 };
    expect(() => assertInstalledExplicitObservation(before, after)).not.toThrow();
    for (const patch of [
      { explicitEntries: 1 },
      { automaticEntries: 2 },
      { automaticCompletions: 2 },
      { producers: 2 },
      { explicitOutcome: "unavailable" },
      { runMatch: false },
    ]) {
      expect(() => assertInstalledExplicitObservation(before, { ...after, ...patch })).toThrow();
    }
  });

  it.each([
    null,
    {},
    { ...baseline, prepared: -1 },
    { ...baseline, automaticEntries: 1.5 },
    { ...baseline, explicitCompletions: 65 },
    { ...baseline, parameterMatch: "true" },
    { ...baseline, idleUnprotectedComposer: undefined },
    { ...baseline, idleUnprotectedComposer: "true" },
  ])("rejects malformed or unbounded observations", (value) =>
    expect(() => readInstalledObservation(value)).toThrow(),
  );
});

function registration() {
  const entity = (name: string) => ({
    fullyQualifiedTypeName: `OpenClawKit.${name}`,
    mangledTypeName: name,
    typeName: name,
    defaultQueryIdentifier: `${name}Query`,
  });
  const action = (name: string, parameters: string[], target: string, entityName: string) => ({
    fullyQualifiedTypeName: `OpenClawKit.${name}`,
    mangledTypeName: name,
    identifier: name,
    isDiscoverable: true,
    parameters: parameters.map((name) => ({
      name,
      ...(name === target ? { valueType: { entity: { wrapper: { typeName: entityName } } } } : {}),
    })),
  });
  return {
    version: 1,
    generator: { name: "xcode-tools" },
    entities: [entity("OpenClawSessionEntity"), entity("OpenClawRunEntity")],
    queries: ["OpenClawSessionEntity", "OpenClawRunEntity"].map((name) => ({
      fullyQualifiedIdentifier: `${name}Query`,
      entityType: name,
    })),
    actions: [
      action(
        "OpenRunIntent",
        ["target", "automatic", "presentationID"],
        "target",
        "OpenClawRunEntity",
      ),
      action("SendMessageIntent", ["session", "message"], "session", "OpenClawSessionEntity"),
      action("InspectRunIntent", ["run"], "run", "OpenClawRunEntity"),
    ],
  };
}
describe("installed metadata registration", () => {
  it("checks understood registration without claiming unknown default or summary encodings", () => {
    expect(() => assertInstalledIntentRegistration(registration())).not.toThrow();
  });
  it.each(["schema", "action", "entity", "query", "parameters", "duplicate", "wrong-target"])(
    "refuses %s drift",
    (mode) => {
      const value = registration();
      if (mode === "schema") value.version = 2;
      if (mode === "action") value.actions.pop();
      if (mode === "entity") value.entities.pop();
      if (mode === "query") value.queries[1]!.entityType = "other";
      if (mode === "parameters") value.actions[0]!.parameters.pop();
      if (mode === "duplicate") value.actions.push(value.actions[0]!);
      if (mode === "wrong-target")
        value.actions[0]!.parameters[0]!.valueType!.entity.wrapper.typeName = "other";
      expect(() => assertInstalledIntentRegistration(value)).toThrow();
    },
  );
});

type Proxy = Awaited<ReturnType<typeof startQaGatewayRpcProxy>>;
async function withMatrix(
  body: (value: {
    matrix: Awaited<ReturnType<typeof createInstalledShortcutsMatrix>>;
    waitStarted: Promise<void>;
    addWire: (scenario: { id: string; sessionKey: string; question: string }) => void;
  }) => Promise<void>,
) {
  const events: Array<Record<string, unknown>> = [];
  const histories = new Map<string, { runID: string; question: string }>();
  const waitStarted = createDeferred<void>();
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const part of request) body += String(part);
      const { action } = JSON.parse(body) as { action: string };
      if (action === "reset") events.length = 0;
      if (action === "wait-held") {
        waitStarted.resolve();
        // A real pending HTTP response, cancelled by the matrix's AbortSignal.
        return;
      }
      response.writeHead(200).end("{}");
    })().catch(() => response.destroy());
  });
  let matrix: Awaited<ReturnType<typeof createInstalledShortcutsMatrix>> | undefined;
  await runQaGatewayFixture(
    async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const fixture = {
        aliceId: "fixture-alice",
        createSession: async (suffix: string) => suffix,
        alice: {
          request: async (_method: string, params: { sessionKey: string; message: string }) => {
            histories.set(params.sessionKey, { runID: "seed-run", question: params.message });
            return { runId: "seed-run" };
          },
        },
        admin: {
          request: async (method: string, params: { sessionKey: string }) => {
            if (method !== "chat.history") return { status: "ok" };
            const value = histories.get(params.sessionKey)!;
            return {
              sessionInfo: { key: params.sessionKey, agentId: "qa" },
              messages: [
                {
                  role: "user",
                  __openclaw: { idempotencyKey: `${value.runID}:user` },
                  content: value.question,
                },
              ],
            };
          },
        },
      } as unknown as ProfileWireFixture<ProfileWireProvider>;
      const proxy = {
        controlUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        snapshot: () => ({ events, heldResponse: undefined }),
      } as unknown as Proxy;
      matrix = await createInstalledShortcutsMatrix(fixture, proxy, "test-token", "test");
      await body({
        matrix,
        waitStarted: waitStarted.promise,
        addWire(scenario) {
          const sends = scenario.id.startsWith("send");
          const runID = sends ? `run-${scenario.id}` : "seed-run";
          histories.set(scenario.sessionKey, { runID, question: scenario.question });
          if (sends)
            events.push(
              {
                kind: "rpc-request",
                method: "chat.send",
                connection: 1,
                sessionKey: scenario.sessionKey,
                expectedProfileId: "fixture-alice",
              },
              { kind: "send-response", ok: true, runId: runID, connection: 1 },
            );
          events.push({
            kind: "rpc-request",
            method: "chat.history",
            inputRunIds: [runID],
            inputRunIdsTruncated: false,
            sessionKey: scenario.sessionKey,
            expectedProfileId: "fixture-alice",
          });
        },
      });
    },
    async () => {
      await matrix?.releaseGates();
      await matrix?.stop();
    },
    async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  );
}

describe("installed matrix gate custody", () => {
  it("refuses missing cases, out-of-order input and dependent teardown before gate release", async () => {
    await withMatrix(async ({ matrix }) => {
      expect(() => matrix.verifyComplete()).toThrow();
      await expect(
        matrix.handle({ action: "begin", id: "send-off", observation: baseline }),
      ).rejects.toThrow();
      await expect(matrix.stop()).rejects.toThrow("Release installed gates");
      await expect(
        matrix.handle({
          action: "begin",
          id: "send-on",
          observation: { ...baseline, idleUnprotectedComposer: false },
        }),
      ).rejects.toThrow("composer has not settled");
      await matrix.handle({ action: "begin", id: "send-on", observation: baseline });
      await expect(
        matrix.handle({ action: "release-downstream", id: "send-on" }),
      ).rejects.toThrow();
      await expect(
        matrix.handle({ action: "begin", id: "send-on", observation: baseline }),
      ).rejects.toThrow();
    });
  });

  it("cancels and joins an HTTP downstream waiter after partial case acquisition", async () => {
    await withMatrix(async ({ matrix }) => {
      await matrix.handle({ action: "begin", id: "send-on", observation: baseline });
      const pending = fetch(matrix.scenarios[0]!.checkpointURL);
      await expect
        .poll(async () => await matrix.handle({ action: "status", id: "send-on" }))
        .toMatchObject({ checkpoint: true });
      await expect(
        matrix.handle({ action: "release-downstream", id: "send-on" }),
      ).rejects.toThrow();
      await matrix.releaseGates();
      const response = await pending;
      expect(response.status).toBe(500);
      await response.text();
      expect(() => matrix.verifyComplete()).toThrow();
    });
  });

  it("reaches the held-ACK case only after completed predecessors, then cancels its exact waiter", async () => {
    await withMatrix(async ({ matrix, waitStarted, addWire }) => {
      let before = baseline;
      for (const scenario of matrix.scenarios.slice(0, 4)) {
        await matrix.handle({ action: "begin", id: scenario.id, observation: before });
        if (scenario.id.endsWith("-off")) {
          // Prepared/zero-auto is true before Send confirmation and ACK. Even
          // otherwise-valid counters cannot bypass the real downstream barrier.
          await expect(
            matrix.handle({
              action: "observe",
              id: scenario.id,
              observation: completed(scenario.id),
              uiVerified: true,
            }),
          ).rejects.toThrow("OFF producer has not returned");
        }
        const checkpoint = fetch(scenario.checkpointURL);
        await expect
          .poll(async () => await matrix.handle({ action: "status", id: scenario.id }))
          .toMatchObject({ checkpoint: true });
        addWire(scenario);
        const next = (downstream: boolean) => {
          const delta = completed(scenario.id, downstream);
          for (const key of [
            "producers",
            "prepared",
            "automaticEntries",
            "automaticCompletions",
            "explicitEntries",
            "explicitCompletions",
          ] as const) {
            delta[key] += before[key];
          }
          return delta;
        };
        await matrix.handle({
          action: "observe",
          id: scenario.id,
          observation: next(false),
          uiVerified: true,
        });
        await matrix.handle({ action: "release-downstream", id: scenario.id });
        expect(await (await checkpoint).text()).toBe("continue");
        expect(await (await fetch(scenario.successURL)).text()).toBe("complete");
        await matrix.handle({
          action: "complete",
          id: scenario.id,
          observation: next(true),
          uiVerified: true,
        });
        before = next(true);
      }
      expect(matrix.bootstrapEvents()).not.toHaveLength(0);
      await matrix.handle({ action: "begin", id: "send-away", observation: before });
      const pending = matrix.handle({ action: "wait-held", id: "send-away" });
      const rejected = expect(pending).rejects.toThrow();
      await waitStarted;
      await matrix.releaseGates();
      await rejected;
      expect(matrix.receipts().map((receipt) => receipt.id)).toEqual(
        installedAutomaticCases.slice(0, 4),
      );
      expect(() => matrix.verifyComplete()).toThrow();
    });
  });
});

describe("installed command failure custody", () => {
  beforeEach(() => vi.mocked(runManagedCommand).mockReset());

  function runner(write?: (record: InstalledCommandDiagnostic) => Promise<void>) {
    const state = { phases: [] as string[], joinedCommands: 0, unjoinedWork: false };
    const records: InstalledCommandDiagnostic[] = [];
    const command = createInstalledCommandRunner(
      "fixture-root",
      state,
      () => "proof-build",
      write ??
        (async (record) => {
          records.push(record);
        }),
    );
    return { state, records, command };
  }

  it("retains bounded compiler stdout and stderr when build fails before xcresult", async () => {
    vi.mocked(runManagedCommand).mockImplementationOnce(async (options) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      options.onReady?.({ stdout, stderr } as unknown as ChildProcess);
      stdout.end(Buffer.from("x".repeat(200_000) + "\nCompileSwift failed\n"));
      stderr.end(Buffer.from("Fixture.swift:12: error: type mismatch\n"));
      return 65;
    });
    const { command, records, state } = runner();
    await expect(command("xcodebuild", ["build-for-testing"])).rejects.toThrow(
      "proof-build: exit 65",
    );
    expect(state).toMatchObject({ joinedCommands: 1, unjoinedWork: false });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      phase: "proof-build",
      exitCode: 65,
      stdout: { truncated: true },
      stderr: { truncated: false },
    });
    expect(Buffer.byteLength(records[0]!.stdout.tail)).toBeLessThanOrEqual(64 * 1024);
    expect(records[0]!.stdout.tail).toContain("CompileSwift failed");
    expect(records[0]!.stderr.tail).toContain("Fixture.swift:12: error: type mismatch");
    expect(records[0]!.error).toContain("proof-build: exit 65");
  });

  it("retains the original command error before diagnostic and subsequent cleanup failures", async () => {
    const original = new Error("compiler transport failed");
    const diagnostic = new Error("private evidence write failed");
    const cleanup = new Error("matrix stop failed");
    const laterCleanup = new Error("provider stop failed");
    vi.mocked(runManagedCommand).mockRejectedValueOnce(original);
    const { command } = runner(async () => {
      throw diagnostic;
    });
    const order: string[] = [];
    const result = runQaGatewayFixture(
      () => command("xcodebuild", ["build-for-testing"]),
      async () => {
        order.push("matrix");
        throw cleanup;
      },
      async () => {
        order.push("provider");
        throw laterCleanup;
      },
    );
    await expect(result).rejects.toMatchObject({
      errors: [expect.objectContaining({ errors: [original, diagnostic] }), cleanup, laterCleanup],
    });
    expect(order).toEqual(["matrix", "provider"]);
  });

  it("keeps the original unjoined failure and refuses dependent teardown", async () => {
    const child = Object.assign(new Error("descendant still alive"), {
      processTreeState: "running",
    });
    const original = new Error("command did not join", { cause: child });
    vi.mocked(runManagedCommand).mockRejectedValueOnce(original);
    const { command, records, state } = runner();
    const dependentCleanup = vi.fn();
    await expect(
      runQaGatewayFixture(
        () => command("xcodebuild", ["test-without-building"]),
        async () => {
          if (!state.unjoinedWork) await dependentCleanup();
        },
      ),
    ).rejects.toBe(original);
    expect(state).toMatchObject({ joinedCommands: 0, unjoinedWork: true });
    expect(dependentCleanup).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({ exitCode: null, unjoinedWork: true });
    expect(records[0]!.error).toContain("descendant still alive");
  });
});
