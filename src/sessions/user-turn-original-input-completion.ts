import { isDeepStrictEqual } from "node:util";
import type { TranscriptEntryAnchor } from "../config/sessions/session-accessor.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  CreateUserTurnTranscriptRecorderParams,
  PersistedUserTurnMessage,
  UserTurnOriginalInputCommit,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

/** One recorder owns capture, ordered callbacks, and their joined postcommit outcome. */
export function createUserTurnOriginalInputCompletion(params: {
  recorder: Pick<
    CreateUserTurnTranscriptRecorderParams,
    "pendingInputSources" | "retainOriginalInputCompletion" | "onOriginalInputCommitted"
  >;
  isBlocked: () => boolean;
  readSourceMessage: () => PersistedUserTurnMessage | undefined;
  captureSource: (
    source: UserTurnTranscriptRecorder,
    anchor: TranscriptEntryAnchor,
  ) => (() => Promise<void>) | undefined;
  onError: (error: unknown) => void;
}) {
  let originalInputCommitted = false;
  let originalInputCompletion: Promise<void> | undefined;
  let completeOriginalInput: (() => Promise<void>) | undefined;
  const captureOriginalInputCompletion = (commit: UserTurnOriginalInputCommit) => {
    const sourceMessage = commit.message;
    const metadata = sourceMessage["__openclaw"];
    if (originalInputCommitted) {
      return completeOriginalInput;
    }
    if (
      params.isBlocked() ||
      sourceMessage.display === false ||
      sourceMessage.excludeFromContext === true ||
      (sourceMessage.provenance && sourceMessage.provenance.kind !== "external_user") ||
      metadata?.lateMedia === true ||
      metadata?.beforeAgentRunBlocked !== undefined
    ) {
      return undefined;
    }
    originalInputCommitted = true;
    const retainedCompletion = params.recorder.retainOriginalInputCompletion?.();
    // Reserve every original source synchronously with the committed bytes.
    // Cancellation after the commit cannot erase or rewrite this obligation.
    const sourceCompletions =
      params.recorder.pendingInputSources &&
      metadata?.humanMentions?.length &&
      isDeepStrictEqual(sourceMessage.content, params.readSourceMessage()?.content)
        ? params.recorder.pendingInputSources.map((source) =>
            params.captureSource(source, commit.anchor),
          )
        : [];
    const completion = createDeferredCore();
    originalInputCompletion = completion.promise;
    let started = false;
    completeOriginalInput = () => {
      // Reserve completion before invoking reentrant callbacks. A collected
      // source waiter joins this promise; only its aggregate starts the work.
      if (!started) {
        started = true;
        completion.resolve(
          trackAsyncWork(async () => {
            try {
              for (const completeSource of sourceCompletions) {
                await completeSource?.();
              }
              const complete = async () => {
                await params.recorder.onOriginalInputCommitted?.(commit);
              };
              if (retainedCompletion) {
                await retainedCompletion(complete);
              } else {
                await complete();
              }
            } catch (error) {
              // Postcommit failure is diagnostic, never a retryable transcript write
              // or a failed lifecycle operation that can replay already-sent notices.
              params.onError(error);
            }
          }).catch(params.onError),
        );
      }
      return completion.promise;
    };
    return completeOriginalInput;
  };

  return {
    capture: captureOriginalInputCompletion,
    get pending() {
      return originalInputCompletion;
    },
  };
}
