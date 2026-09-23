import type { SqliteWorkerReply } from "../../infra/sqlite-worker-contract.js";
import type { StateDatabaseCoordinatorRuntime } from "../../infra/state-database-coordinator.js";
import type { CronRunRecord } from "./run-history.types.js";
import type { LoadedCronStore } from "./types.js";

export type CronReadOnlyRequest = {
  location: string;
  history?: { jobId?: string };
  storeKey: string;
  stagingRoot?: string;
  coordinatorRuntime: StateDatabaseCoordinatorRuntime;
};
export type CronReadOnlyResult =
  | { ok: true; loaded?: LoadedCronStore; history?: CronRunRecord[] }
  | { ok: false; error: Extract<SqliteWorkerReply, { ok: false }>["error"] };
