import {
  createMediaGenerationOperation,
  findMediaGenerationOperation,
} from "./media-generation-activity.js";
import type { MediaGenerationTaskHandle } from "./tools/media-generate-background-completion.js";

/** Literal completion handles in transport tests still need real native admission. */
export function admitMediaHandle<T extends MediaGenerationTaskHandle>(handle: T): T {
  if (!findMediaGenerationOperation(handle.runId)) {
    createMediaGenerationOperation({
      taskId: handle.taskId,
      runId: handle.runId,
      taskKind: "image_generation",
      requesterSessionKey: handle.requesterSessionKey,
      requesterAgentId: handle.requesterAgentId,
      task: handle.taskLabel,
      createdAt: Date.now(),
      status: "running",
    });
  }
  return handle;
}
