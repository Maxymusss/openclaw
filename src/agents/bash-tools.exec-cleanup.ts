import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { ProcessScopeCleanupPolicy } from "../process/supervisor/types.js";
import { waitForExecScope } from "./bash-process-registry.js";

/** Acquire before exposing tools; transport exit alone cannot certify backend cleanup. */
export function acquireExecScopeCleanup(scopeKey: string, processTree: ProcessScopeCleanupPolicy) {
  const cleanupScope = getProcessSupervisor().acquireScopeCleanup(scopeKey, { processTree });
  return async () => {
    const settled = await Promise.allSettled([cleanupScope(), waitForExecScope(scopeKey)]);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
  };
}
