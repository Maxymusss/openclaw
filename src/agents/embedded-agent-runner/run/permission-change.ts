import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import type { AdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { resolveSessionPermissionExecMode } from "../../session-permission-exec-mode.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const PERMISSION_CHANGE_NOTICE =
  "Permission change. The operator changed this session's permissions. Continue with the updated policy, preserving completed work. Inspect interrupted actions before retrying them; do not repeat completed actions.";

type PermissionMode = NonNullable<RunEmbeddedAgentParams["permissionMode"]> | null;
type AttemptPermissionChange = NonNullable<EmbeddedRunAttemptParams["permissionChange"]>;
type PermissionChangeAuthority = {
  authorized?: { mode: PermissionMode };
  preparePublication: (
    attempt: AttemptPermissionChange,
    mode: PermissionMode,
    publish: () => void,
  ) => () => void;
};
// Gateway dispatch and harness setup can load separate runtime chunks. Their
// private authority registry must still recognize the exact same run owner.
const permissionChangeAuthorities = resolveGlobalSingleton(
  Symbol.for("openclaw.embeddedRunPermissionChangeAuthorities"),
  () => new WeakMap<object, PermissionChangeAuthority>(),
);

/** Core dispatcher alone authorizes the synchronous handoff after its operator/owner checks. */
export function withAuthorizedPermissionChange<T>(
  owner: object,
  mode: PermissionMode,
  apply: () => T,
): T {
  const authority = permissionChangeAuthorities.get(owner);
  if (!authority) {
    throw new Error("Permission change run owner is no longer active.");
  }
  const previous = authority.authorized;
  authority.authorized = { mode };
  try {
    return apply();
  } finally {
    // Async work may retain an accepted request, never this authorization scope.
    authority.authorized = previous;
  }
}

/** Retain one accepted publication, never the ambient permission authorization across cleanup. */
export function prepareEmbeddedPermissionPublication(
  attempt: AttemptPermissionChange,
  mode: PermissionMode,
  publication: {
    operatorAuthority: AdmittedRunOperatorAuthority;
    runAbortSignal: AbortSignal;
    assertActiveRun: (() => void) | undefined;
    publish: () => void;
  },
): () => void {
  const authority = permissionChangeAuthorities.get(attempt.owner);
  if (!authority) {
    throw new Error("Permission change run owner is no longer active.");
  }
  const { operatorAuthority, runAbortSignal, assertActiveRun, publish } = publication;
  return authority.preparePublication(attempt, mode, () => {
    // Cleanup can settle before this continuation runs. Publication still needs
    // the original source, deadline and attempt to be live in this microtask.
    operatorAuthority.assertCurrent();
    runAbortSignal.throwIfAborted();
    assertActiveRun?.();
    publish();
  });
}

/** Owns apply acknowledgements across replacement attempts within one admitted run. */
export function createEmbeddedRunPermissionChanges(
  params: Pick<RunEmbeddedAgentParams, "execOverrides" | "permissionMode">,
) {
  const owner = Object.freeze({});
  let currentAttempt: AttemptPermissionChange | undefined;
  let activePublication: object | undefined;
  const authority: PermissionChangeAuthority = {
    preparePublication: (attempt, mode, publish) => {
      assertAuthorized(mode);
      if (currentAttempt !== attempt) {
        throw new Error("Permission change attempt is no longer active.");
      }
      const publication = { consumed: false };
      const acceptedRevision = revision;
      activePublication = publication;
      const assertCurrent = () => {
        if (
          closed ||
          permissionChangeAuthorities.get(owner) !== authority ||
          currentAttempt !== attempt ||
          revision !== acceptedRevision ||
          activePublication !== publication
        ) {
          throw new Error("Permission change publication is no longer current.");
        }
      };
      return () => {
        assertCurrent();
        if (publication.consumed) {
          throw new Error("Permission change publication was already consumed.");
        }
        // Consume before publication: partial publication must never be retried
        // under a retained receipt or recorded as successfully applied.
        publication.consumed = true;
        publish();
        assertCurrent();
        activePublication = undefined;
        updatePermissionMode(mode);
      };
    },
  };
  permissionChangeAuthorities.set(owner, authority);
  const baseExecOverrides = Object.freeze({ ...params.execOverrides });
  let closed = false;
  let revision = 0;
  let pending:
    | {
        mode: NonNullable<RunEmbeddedAgentParams["permissionMode"]> | null;
        revision: number;
        promise: Promise<boolean>;
        resolve: (applied: boolean) => void;
      }
    | undefined;
  const assertAuthorized = (mode: PermissionMode) => {
    if (
      closed ||
      permissionChangeAuthorities.get(owner) !== authority ||
      authority.authorized?.mode !== mode
    ) {
      throw new Error("Permission change was not authorized by the current operator request.");
    }
  };
  const updatePermissionMode = (mode: PermissionMode) => {
    params.permissionMode = mode ?? undefined;
    // Keep the existing shared exec object: plugin requirement clamps are
    // observed by the outer run. Clearing a mode restores the pre-run policy.
    params.execOverrides ??= {};
    params.execOverrides.mode = mode
      ? resolveSessionPermissionExecMode({ mode })
      : baseExecOverrides.mode;
  };
  const request: NonNullable<EmbeddedRunAttemptParams["permissionChange"]>["request"] = (mode) => {
    assertAuthorized(mode);
    activePublication = undefined;
    if (pending?.mode === mode) {
      return pending.promise;
    }
    pending?.resolve(false);
    const completion = createDeferredCore<boolean>();
    pending = { mode, revision: ++revision, ...completion };
    return pending.promise;
  };
  return {
    forAttempt(): NonNullable<EmbeddedRunAttemptParams["permissionChange"]> {
      const preparedRevision = revision;
      activePublication = undefined;
      const attempt: AttemptPermissionChange = {
        owner,
        baseExecOverrides,
        ...(revision > 0
          ? {
              notice: `${PERMISSION_CHANGE_NOTICE} Requested mode: ${params.permissionMode ?? "default"}.`,
            }
          : {}),
        request,
        recordApplied: (mode) => {
          assertAuthorized(mode);
          activePublication = undefined;
          updatePermissionMode(mode);
        },
        applied: () => {
          if (closed || preparedRevision !== revision) {
            return false;
          }
          pending?.resolve(true);
          pending = undefined;
          return true;
        },
      };
      currentAttempt = attempt;
      return attempt;
    },
    prepareRestart: () => {
      if (closed || !pending) {
        return false;
      }
      updatePermissionMode(pending.mode);
      return true;
    },
    close: () => {
      closed = true;
      permissionChangeAuthorities.delete(owner);
      pending?.resolve(false);
      pending = undefined;
    },
  };
}
