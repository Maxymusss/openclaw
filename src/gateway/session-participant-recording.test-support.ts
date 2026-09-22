import { expect, onTestFinished, vi } from "vitest";
import type { WebSocket } from "ws";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import * as participantRecording from "../sessions/session-participant-recording.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { agentCommandMock, rpcReq } from "./test-helpers.js";

/** Join real deferred participant writes before inspecting retained request roots. */
export function observeParticipantRecording() {
  const work = new AsyncWorkScope();
  const record = participantRecording.recordSessionParticipantBestEffort;
  const observer = vi
    .spyOn(participantRecording, "recordSessionParticipantBestEffort")
    .mockImplementation((params) => work.run(() => record(params)));
  onTestFinished(async () => {
    observer.mockRestore();
    await work.drain();
  });
  return () => work.runWhenIdle(getActiveGatewayRootWorkCount);
}

export async function expectAgentSendAndParticipantCompletion(
  ws: WebSocket,
  sessionKey: string,
  runId: string,
) {
  const participantsSettled = observeParticipantRecording();
  agentCommandMock.mockClear();
  const response = await rpcReq(ws, "agent", { message: "hi", sessionKey, idempotencyKey: runId });
  expect(response).toMatchObject({ ok: true, payload: { status: "accepted", runId } });
  await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalled(), { interval: 1 });
  expect(await participantsSettled()).toBe(0);
}
