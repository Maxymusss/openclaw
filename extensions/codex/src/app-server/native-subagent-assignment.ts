/**
 * Shared identifiers for Codex native subagent execution and completion receipts.
 */
export type NativeSubagentAssignment = {
  runId: string;
  childThreadId: string;
  nativeTurnId: string | undefined;
};

/** Run ID prefix for native child thread assignments. */
export const CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX = "codex-thread:";

/** Initial assignments use the thread locator; follow-ups belong to a native turn. */
export function codexNativeSubagentRunId(threadId: string, turnId?: string): string {
  return `${CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX}${threadId.trim()}${turnId ? `:turn:${turnId}` : ""}`;
}

export function readCodexNativeSubagentRunId(
  runId: string | undefined,
): { threadId: string; turnId?: string } | undefined {
  if (!runId?.startsWith(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX)) {
    return undefined;
  }
  const [threadId, turnId] = runId
    .slice(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX.length)
    .split(":turn:");
  return threadId?.trim() ? { threadId, ...(turnId ? { turnId } : {}) } : undefined;
}

export function readNativeSubagentThreadIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}
