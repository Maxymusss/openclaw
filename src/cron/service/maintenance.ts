import { runSessionRegistryMaintenance } from "../session-registry-maintenance.js";
import { pruneCronRunHistory } from "../store/run-history.js";
import type { CronServiceState } from "./state.js";

const lastSweep = new WeakMap<CronServiceState, number>();
/** Shares the scheduler's existing maintenance lifetime, never an independent background loop. */
export async function runCronMaintenance(state: CronServiceState): Promise<void> {
  const now = state.deps.nowMs();
  const previous = lastSweep.get(state);
  if (previous !== undefined && now >= previous && now - previous < 5 * 60_000) {
    return;
  }
  lastSweep.set(state, now);
  await pruneCronRunHistory(now);
  const result = await runSessionRegistryMaintenance({ apply: true });
  if (result.skippedReason) {
    state.deps.log.warn(
      { reason: result.skippedReason },
      "cron: session registry maintenance skipped",
    );
  }
}
