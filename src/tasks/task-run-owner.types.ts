import type { Result } from "@openclaw/normalization-core/result";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskRunOwner = {
  /** Liveness projection only; execution and result operations stay with the followup owner. */
  followupCompletion?: { isLive(): boolean };
  /** Live creation-receipt custody, including its physical database and exact task generation. */
  assertCurrent?: () => void;
  readCurrent?: () => Readonly<TaskRecord>;
  task: Readonly<
    Pick<TaskRecord, "taskId" | "runtime" | "ownerKey" | "scopeKind" | "runId" | "childSessionKey">
  >;
  cancel: (reason: string) => Promise<Result<TaskRecord, string>>;
};

export type TaskRunOwnerBinding = { owner: TaskRunOwner; release: () => void };
