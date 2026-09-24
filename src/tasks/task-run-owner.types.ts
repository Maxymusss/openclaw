import type { Result } from "@openclaw/normalization-core/result";
import type { TaskFollowupCompletion } from "./task-followup-completion.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskRunOwner = {
  followupCompletion?: TaskFollowupCompletion;
  /** Live creation-receipt custody, including its physical database and exact task generation. */
  assertCurrent?: () => void;
  readCurrent?: () => Readonly<TaskRecord>;
  task: Readonly<
    Pick<TaskRecord, "taskId" | "runtime" | "ownerKey" | "scopeKind" | "runId" | "childSessionKey">
  >;
  cancel: (reason: string) => Promise<Result<TaskRecord, string>>;
};

export type TaskRunOwnerBinding = { owner: TaskRunOwner; release: () => void };
