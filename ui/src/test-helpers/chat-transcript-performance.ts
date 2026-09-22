/** Settled dashboard turns also remain valid channel transcript fixtures. */
export function createTranscriptPerformanceMessages(messageCount: number) {
  return Array.from({ length: messageCount }, (_, index) => {
    const runId = `history-run-${Math.floor(index / 4)}`;
    const phase = index % 4;
    const sentinel = index === messageCount - 1 ? " LONG-TAIL-SENTINEL" : "";
    const text = `History ${index}: ${"context ".repeat(16)}${sentinel}`;
    return {
      role: phase === 0 ? "user" : phase === 2 ? "toolResult" : "assistant",
      content: [{ type: "text", text }],
      timestamp: 1_700_000_000_000 + index * 1_000,
      ...(phase === 0 ? {} : { runId }),
      ...(phase === 1 ? { phase: "commentary" } : {}),
      ...(phase === 2 ? { toolName: "read", toolCallId: `read-${runId}` } : {}),
      ...(phase === 3 ? { phase: "final_answer", stopReason: "stop" } : {}),
      __openclaw: {
        id: `history-message-${index}`,
        seq: index + 1,
        ...(phase === 0 ? { idempotencyKey: `${runId}:user` } : {}),
      },
    };
  });
}
