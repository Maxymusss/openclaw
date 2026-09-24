import { normalizeAgentRunTerminalReceipt } from "../../agents/agent-run-terminal-receipt.js";
import { normalizeAgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.js";
import type { EmbeddedAgentRunMeta } from "../../agents/embedded-agent-runner/types.js";
import type { TaskFollowupCompletion } from "../../tasks/task-followup-completion.js";

/** Logical settlement retains the physical registration guard through its worker commit. */
export async function settleFollowupTaskExecution(
  completion: TaskFollowupCompletion,
  runId: string,
  reply: Parameters<TaskFollowupCompletion["settle"]>[1],
  isPhysicalCurrent: () => boolean,
): Promise<void> {
  if (!completion.ownsExecution(runId)) {
    return;
  }
  const assertCurrent = () => {
    completion.assertCurrent();
    if (!isPhysicalCurrent()) {
      throw new Error("Follow-up physical execution lost its Gateway registration.");
    }
  };
  try {
    assertCurrent();
    await completion.settle(runId, reply, assertCurrent);
  } catch (error) {
    completion.close(error);
    throw error;
  }
}

export function readFollowupTerminalReply(runId: string, meta: EmbeddedAgentRunMeta | undefined) {
  const terminalReply = normalizeAgentRunTerminalReplySnapshot(meta?.terminalReply);
  const receipt = normalizeAgentRunTerminalReceipt(meta?.agentMeta?.terminalReceipt);
  return {
    terminalReply,
    ...(terminalReply?.disposition === "visible" ? { replyText: terminalReply.text } : {}),
    ...(receipt?.runId === runId && receipt.sourceReplyDelivered
      ? { sourceReplyDelivered: true as const }
      : {}),
  };
}
