/** Lists, waits for, and cancels native subagent executions. */
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { sanitizeRunStatusText } from "../run-status-text.js";
import { optionalPositiveIntegerSchema, optionalStringEnum } from "../schema/typebox.js";
import { ensureSubagentControllerOwnsRun } from "../subagents/registry/subagent-control-scope.js";
import {
  DEFAULT_RECENT_MINUTES,
  killSubagentRunAdmin,
  listControlledSubagentRuns,
  MAX_RECENT_MINUTES,
  resolveSubagentController,
} from "../subagents/registry/subagent-control.js";
import { observeSubagentExecution } from "../subagents/registry/subagent-execution-observation.js";
import { buildSubagentList } from "../subagents/registry/subagent-list.js";
import { onSubagentRegistryPersisted } from "../subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readToolStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";

const SUBAGENT_ACTIONS = ["list", "wait", "cancel"] as const;
const SubagentsToolSchema = Type.Object({
  action: optionalStringEnum(SUBAGENT_ACTIONS),
  recentMinutes: optionalPositiveIntegerSchema(),
  runId: Type.Optional(Type.String()),
  runIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })),
});
type SubagentsToolOptions = {
  agentSessionKey?: string;
  callerPolicySessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
};
function mapRun(run: SubagentRunRecord) {
  return {
    runId: run.runId,
    sessionKey: run.childSessionKey,
    label: sanitizeRunStatusText(run.label, { maxChars: 80 }) || undefined,
    status: run.pauseReason === "sessions_yield" ? "waiting" : run.execution.status,
    outcome: run.execution.outcome
      ? {
          status: run.execution.outcome.status,
          error:
            sanitizeRunStatusText(run.execution.outcome.error, {
              errorContext: true,
              maxChars: 120,
            }) || undefined,
        }
      : undefined,
    deliveryStatus: run.delivery?.status,
    startedAt: run.execution.startedAt,
    endedAt: run.execution.endedAt,
  };
}
function waitForSelectedRuns(params: {
  runIds: string[];
  readRuns: () => SubagentRunRecord[];
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  const read = () => {
    const visible = new Map(params.readRuns().map((task) => [task.runId, task]));
    const tasks = params.runIds.flatMap((runId) => {
      const task = visible.get(runId);
      return task ? [task] : [];
    });
    const unavailable = params.runIds.filter((runId) => !visible.has(runId));
    const attention = tasks.filter((task) => {
      const wait = observeSubagentExecution(task, []).wait;
      return task.delivery?.status === "suspended" || wait?.kind === "external";
    });
    const completed = tasks.filter(
      (task) => task.execution.status === "terminal" && task.pauseReason !== "sessions_yield",
    );
    return {
      reason: unavailable.length
        ? "unavailable"
        : attention.length
          ? "attention"
          : completed.length
            ? "completed"
            : undefined,
      runs: tasks.map(mapRun),
      completed: completed.map((task) => task.runId),
      attention: attention.map((task) => task.runId),
      ...(unavailable.length ? { unavailable } : {}),
    };
  };
  return new Promise<ReturnType<typeof read>>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: Error, timeout = false) => {
      if (settled) {
        return;
      }
      try {
        const state = error ? undefined : read();
        if (!error && !timeout && !state?.reason) {
          return;
        }
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        params.signal?.removeEventListener("abort", onAbort);
        if (error) {
          reject(error);
        } else if (state) {
          resolve({ ...state, reason: state.reason ?? "timeout" });
        }
      } catch (readError) {
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        params.signal?.removeEventListener("abort", onAbort);
        reject(
          readError instanceof Error
            ? readError
            : new Error(String(readError), { cause: readError }),
        );
      }
    };
    const onAbort = () =>
      finish(createAbortError("subagents wait aborted; tasks continue running."));
    let wakeQueued = false;
    const wake = () => {
      if (wakeQueued || settled) {
        return;
      }
      wakeQueued = true;
      // The publisher retires its mutation before a reader checks the resulting identity.
      queueMicrotask(() => {
        wakeQueued = false;
        finish();
      });
    };
    const unsubscribeSubagents = onSubagentRegistryPersisted(wake);
    unsubscribe = () => {
      unsubscribeSubagents();
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(undefined, true), params.timeoutMs);
    if (params.signal?.aborted) {
      onAbort();
    } else {
      // Subscribe before reading so completion cannot be lost between those operations.
      finish(undefined, params.timeoutMs === 0);
    }
  });
}

export function createSubagentsTool(opts: SubagentsToolOptions = {}): AnyAgentTool {
  const readScope = () => {
    const cfg = opts.config ?? getRuntimeConfig();
    const controller = resolveSubagentController({
      cfg,
      agentSessionKey: opts.agentSessionKey,
      agentId: opts.agentId,
    });
    if (!controller.controllerAgentId) {
      throw new ToolInputError("Subagent controller agent required");
    }
    const runs = listControlledSubagentRuns(
      controller.controllerSessionKey,
      controller.controllerAgentId,
      cfg,
    );
    const readable = new Map<string, SubagentRunRecord>();
    const controlled = new Set<string>();
    const pending = [{ owner: controller, entries: runs }];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.shift()!;
      const identity = current.owner.controllerAgentId + "\0" + current.owner.controllerSessionKey;
      if (visited.has(identity)) {
        continue;
      }
      visited.add(identity);
      for (const entry of current.entries) {
        readable.set(entry.runId, entry);
        if (
          controller.controlScope !== "children" ||
          ensureSubagentControllerOwnsRun({ cfg, controller: current.owner, entry })
        ) {
          continue;
        }
        controlled.add(entry.runId);
        const childController = resolveSubagentController({
          cfg,
          agentSessionKey: entry.childSessionKey,
        });
        pending.push({
          owner: childController,
          entries: listControlledSubagentRuns(
            childController.controllerSessionKey,
            childController.controllerAgentId,
            cfg,
          ),
        });
      }
    }
    return { cfg, controller, runs, readable: [...readable.values()], controlled };
  };
  return {
    label: "Subagents",
    name: "subagents",
    parameters: SubagentsToolSchema,
    description:
      "List native subagents, wait for selected runIds, or cancel a runId and its descendants. A wait timeout never cancels execution or consumes completion delivery.",
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const action = readToolStringParam(params, "action") ?? "list";
      if (action === "wait") {
        const runIds = [...new Set(readStringArrayParam(params, "runIds", { required: true }))];
        if (runIds.length > 32) {
          throw new ToolInputError("At most 32 runIds may be waited for");
        }
        return jsonResult({
          status: "ok",
          action,
          ...(await waitForSelectedRuns({
            runIds,
            readRuns: () => readScope().readable,
            timeoutMs:
              Math.min(60, readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30) * 1000,
            signal,
          })),
        });
      }
      const { cfg, controller, runs, readable, controlled } = readScope();
      if (action === "list") {
        const list = buildSubagentList({
          cfg,
          runs,
          recentMinutes: Math.min(
            MAX_RECENT_MINUTES,
            readPositiveIntegerParam(params, "recentMinutes") ?? DEFAULT_RECENT_MINUTES,
          ),
        });
        return jsonResult({
          status: "ok",
          action,
          requesterSessionKey: controller.controllerSessionKey,
          callerSessionKey: controller.callerSessionKey,
          callerIsSubagent: controller.callerIsSubagent,
          total: list.total,
          active: list.active.map(({ line: _line, ...view }) => view),
          recent: list.recent.map(({ line: _line, ...view }) => view),
          text: list.text,
        });
      }
      if (action === "cancel") {
        const runId = readToolStringParam(params, "runId", { required: true });
        const target = readable.find((run) => run.runId === runId);
        if (!target || !controlled.has(runId)) {
          return jsonResult({
            status: "forbidden",
            error: "Run outside the controlled session tree.",
          });
        }
        const result = await killSubagentRunAdmin(
          {
            cfg,
            sessionKey: target.childSessionKey,
            agentId: target.requesterAgentId,
            expectedRunId: target.runId,
            expectedTaskRunId: target.taskRunId ?? target.runId,
            expectedGeneration: target.generation,
            expectedOwnerKey: target.requesterSessionKey,
          },
          {
            assertCurrent: () => {
              signal?.throwIfAborted();
              const current = readScope();
              if (
                current.controller.controllerSessionKey !== controller.controllerSessionKey ||
                current.controller.controllerAgentId !== controller.controllerAgentId ||
                !current.controlled.has(target.runId) ||
                !current.readable.some(
                  (run) => run.runId === target.runId && run.generation === target.generation,
                )
              ) {
                throw new Error("Subagent cancellation owner changed");
              }
            },
          },
        );
        return jsonResult({ ...result, action, runId });
      }
      throw new ToolInputError("Unsupported subagents action");
    },
  };
}
