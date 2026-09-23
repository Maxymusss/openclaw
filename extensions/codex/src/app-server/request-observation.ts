import { threadId } from "node:worker_threads";

export type CodexControlRequestPhase =
  | "load-control"
  | "prepare"
  | "acquire-client"
  | "client-request"
  | "release-client";

export type CodexControlRequestFailureCategory =
  | "deadline-observed"
  | "scoped-rejection"
  | "rpc-method-unavailable"
  | "rpc-error"
  | "other";

export type CodexControlRequestFailure = {
  phase: CodexControlRequestPhase;
  category: CodexControlRequestFailureCategory;
};

export const CODEX_REQUEST_WAITER_OUTCOMES = [
  "resolved",
  "native-error",
  "timed-out",
  "aborted",
  "authority-rejected",
  "local-failed",
  "client-closed",
] as const;
export type CodexRequestWaiterOutcome = (typeof CODEX_REQUEST_WAITER_OUTCOMES)[number];

export const CODEX_REQUEST_WIRE_OUTCOMES = [
  "retained-pending",
  "native-ok",
  "native-error",
  "ingress-rejected",
  "correlation-closed",
  "not-written",
] as const;
export type CodexRequestWireOutcome = (typeof CODEX_REQUEST_WIRE_OUTCOMES)[number];

export type CodexRequestWaiterSummary = {
  clientInstanceId: string;
  rpcId: number;
  waiterOrdinal: number;
  disposition: "new" | "joined";
  overloadAttemptOrdinal: number;
  attemptCreatedAtMs: number;
  firstPossibleWriteAtMs: number | null;
  waiterAttachedAtMs: number;
  waiterSettledAtMs: number;
  waiterOutcome: CodexRequestWaiterOutcome;
  wireOutcomeAtWaiterSettlement: CodexRequestWireOutcome;
  wireObservedAtMs: number | null;
};

export type CodexRequestWaiterFinished = (summary: CodexRequestWaiterSummary) => void;

export type CodexControlRequestObservation = {
  phase(phase: CodexControlRequestPhase): void;
  failed(failure: CodexControlRequestFailure): void;
  attemptWaiterFinished?: CodexRequestWaiterFinished;
};

// TEMP: one deadline-owner receipt; fixed milestones never include auth, args or paths.
type StartupStage =
  | "context-resolve"
  | "context-resolved"
  | "selected"
  | "candidate-prepare"
  | "client-start"
  | "registration-prepare"
  | "spawn-call"
  | "spawn-returned"
  | "client-constructed"
  | "registration-pending"
  | "registered"
  | "initialize"
  | "initialized"
  | "catalog-observation"
  | "auth-apply"
  | "ready";

type StartupState = {
  id: number;
  candidate: number | null;
  lastReachedStage: StartupStage | "UNKNOWN";
  reachedAtMs: Partial<Record<StartupStage, number>>;
  childPid: number | null;
  clientId: string | null;
};

export type CodexStartupObservation = {
  contextReachedAtMs: Partial<Record<"context-resolve" | "context-resolved", number>>;
  current: StartupState | undefined;
};
export type CodexDeadlineCaller =
  | "generic-rpc"
  | "usage"
  | "model-catalog"
  | "command-rpc"
  | "plugin-command"
  | "migration";

const observedMethods = new Set([
  "initialize",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "account/rateLimits/read",
  "account/read",
  "app/installed",
  "app/list",
  "app/read",
  "command/exec",
  "config/batchWrite",
  "config/mcpServer/reload",
  "config/read",
  "configRequirements/read",
  "config/value/write",
  "environment/add",
  "experimentalFeature/list",
  "experimentalFeature/enablement/set",
  "feedback/upload",
  "hooks/list",
  "marketplace/add",
  "mcpServerStatus/list",
  "mcpServer/resource/read",
  "mcpServer/tool/call",
  "model/list",
  "modelProvider/capabilities/read",
  "plugin/installed",
  "plugin/install",
  "plugin/list",
  "plugin/read",
  "review/start",
  "skills/list",
  "thread/compact/start",
  "thread/archive",
  "thread/delete",
  "thread/fork",
  "thread/inject_items",
  "thread/list",
  "thread/turns/list",
  "thread/items/list",
  "thread/name/set",
  "thread/read",
  "thread/resume",
  "thread/start",
  "thread/unarchive",
  "thread/unsubscribe",
  "thread/goal/set",
  "thread/goal/get",
  "thread/goal/clear",
  "turn/interrupt",
  "turn/start",
  "turn/steer",
]);

let observationSequence = 0;
const startupObservations = new WeakMap<object, CodexStartupObservation>();

export function createCodexStartupObservation(): CodexStartupObservation {
  return {
    contextReachedAtMs: {},
    current: {
      id: ++observationSequence,
      candidate: null,
      lastReachedStage: "UNKNOWN",
      reachedAtMs: {},
      childPid: null,
      clientId: null,
    },
  };
}

export function bindCodexStartupObservation(
  entry: { startup?: unknown },
  waiter: CodexStartupObservation | undefined,
): CodexStartupObservation {
  let owner = startupObservations.get(entry);
  if (!owner) {
    // A startup from another module copy has no observed history; never invent it.
    owner = entry.startup
      ? { contextReachedAtMs: {}, current: undefined }
      : createCodexStartupObservation();
    startupObservations.set(entry, owner);
    noteCodexStartup(owner, "selected");
  }
  if (waiter) {
    waiter.current = owner.current;
  }
  return owner;
}

export function noteCodexStartup(
  observation: CodexStartupObservation | undefined,
  stage: StartupStage,
  client?: { getInstanceId(): string; getTransportPid(): number | undefined },
  childPid?: number,
): void {
  try {
    if (observation && (stage === "context-resolve" || stage === "context-resolved")) {
      observation.contextReachedAtMs[stage] = performance.now();
    }
    const state = observation?.current;
    if (!state) {
      return;
    }
    if (stage === "candidate-prepare") {
      state.candidate = (state.candidate ?? 0) + 1;
      state.reachedAtMs = {};
      state.childPid = null;
      state.clientId = null;
    }
    state.lastReachedStage = stage;
    state.reachedAtMs[stage] = performance.now();
    if (childPid !== undefined) {
      state.childPid = childPid;
    }
    if (client) {
      state.clientId = client.getInstanceId();
      state.childPid = client.getTransportPid() ?? state.childPid;
    }
  } catch {
    // Temporary observation cannot change startup or its original exception.
  }
}

export function recordCodexRequestDeadline(params: {
  operation: number;
  attempt: number;
  caller: CodexDeadlineCaller | undefined;
  phase: CodexControlRequestPhase;
  errorPhase: CodexControlRequestPhase | undefined;
  timeoutMs: number;
  deadline: number | undefined;
  methodAtApi: string | undefined;
  startup: CodexStartupObservation | undefined;
}): void {
  try {
    // Snapshot in the terminal catch: late acquisition/cleanup may still mutate startup.
    // Existing stderr capture owns this one line; no imports or diagnostic await warm startup.
    const { startup, methodAtApi, caller, ...scope } = params;
    console.error(
      "[codex-request-deadline] " +
        JSON.stringify({
          ...scope,
          pid: process.pid,
          threadId,
          processTimeOrigin: performance.timeOrigin,
          observedAtMs: performance.now(),
          caller: caller ?? "UNKNOWN",
          methodAtApi:
            methodAtApi === undefined
              ? "UNKNOWN"
              : observedMethods.has(methodAtApi)
                ? methodAtApi
                : "OTHER",
          methodIsPhysicalWrite: false,
          contextReachedAtMs: startup?.contextReachedAtMs ?? "UNKNOWN",
          sharedStartupHistory: startup?.current ?? "UNKNOWN",
          lastReachedStageIsActiveOperation: false,
        }),
    );
  } catch {
    // Keep the original error, including falsy throws and the existing deadline wrapper.
  }
}

export function nextCodexDeadlineOperation(): number {
  return ++observationSequence;
}
