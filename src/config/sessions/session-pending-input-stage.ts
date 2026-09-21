import type {
  SessionPendingInputRow,
  readSessionInputCompletion,
} from "./session-accessor.sqlite-pending-inputs.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type { SessionEntry } from "./types.js";

/** Current facts supplied only by the connection-bound pending-input operation. */
export type SessionPendingInputAuthorityFacts = {
  kind: "session.pending-input";
  agentId: string;
  storePath: string;
  sessionKey: string;
  entry?: SessionEntry;
  members: SessionMember[];
};
export type SessionPendingInputStageAuthority = {
  assertCurrent(): void;
  authorize(facts: SessionPendingInputAuthorityFacts): void;
};
export type PendingInputStageInspection = {
  entry?: SessionEntry;
  existing?: SessionPendingInputRow;
  previous?: ReturnType<typeof readSessionInputCompletion>;
  committed?: ReturnType<typeof readTranscriptMessageByScopedIdempotencyKey>;
};
export type PendingInputStageRead = {
  scope: ResolvedTranscriptScope;
  idempotencyKey: string;
  trackCompletion?: boolean;
};
export type PendingInputStageWrite = PendingInputStageRead & {
  expected: PendingInputStageInspection;
  inputId: string;
  runId: string;
  requestHash: string;
  messageJson: string;
  lifecycleGeneration: string;
};
export type PendingInputStageOperations = {
  "pendingInput.inspect": { input: PendingInputStageRead; output: PendingInputStageInspection };
  "pendingInput.transcript": {
    input: PendingInputStageRead;
    output: PendingInputStageInspection["committed"];
  };
  "pendingInput.stage": { input: PendingInputStageWrite; output: boolean };
};
