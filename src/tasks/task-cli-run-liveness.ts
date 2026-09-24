import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { TaskRecord } from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";

export function hasActiveCliRun(task: TaskRecord): boolean {
  if (getTaskRunOwner(task)?.followupCompletion?.isLive()) {
    return true;
  }
  const candidateRunIds = [task.sourceId, task.runId];
  for (const candidate of candidateRunIds) {
    const runId = candidate?.trim();
    if (runId && getAgentRunContext(runId)) {
      return true;
    }
  }
  return false;
}

export function hasCliRunIdentity(task: TaskRecord): boolean {
  return [task.sourceId, task.runId].some((candidate) => Boolean(candidate?.trim()));
}
