import { vi } from "vitest";
import type { FollowupRequest } from "../../tasks/task-followup-completion.types.js";

export function createDispatchFollowupRequest({
  runId,
  sessionKey,
}: {
  runId: string;
  sessionKey: string;
}): FollowupRequest {
  return {
    runId,
    requesterSessionKey: "agent:main:parent",
    requesterSessionId: "requester-session",
    requesterAgentId: "main",
    targetAgentId: "main",
    targetSessionKey: sessionKey,
    custody: {
      run: (work) => work(),
      assertCurrent: vi.fn(),
      signal: new AbortController().signal,
      release: vi.fn(),
    },
  };
}
