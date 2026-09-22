import { createSessionWorkAdmissionRefusal } from "./session-work-admission-handoff.js";
import type { SessionWorkAdmissionInterrupt } from "./session-work-admission-interruption.js";

export type SessionWorkAdmissionClosure = {
  identities: readonly string[];
  reason: Error;
  sticky?: true;
};

/** Operates on the lifecycle owner's existing close set; never stores a second identity index. */
export function createSessionWorkAdmissionClosureOwner(
  closures: Set<SessionWorkAdmissionClosure>,
  interruptPending: (
    identities: readonly string[],
    reason: Error,
    onError?: (error: unknown) => void,
  ) => void,
) {
  const find = (identities: ReadonlySet<string>, stickyOnly = false) =>
    [...closures].find(
      (owner) =>
        (!stickyOnly || owner.sticky) &&
        owner.identities.some((identity) => identities.has(identity)),
    );
  return {
    interruptIfClosed(identities: ReadonlySet<string>, interrupt?: SessionWorkAdmissionInterrupt) {
      const owner = find(identities);
      if (owner) {
        interrupt?.(owner.reason);
      }
    },
    assertNotRefused(identities: ReadonlySet<string>) {
      const refusal = find(identities, true);
      if (refusal) {
        throw refusal.reason;
      }
    },
    createRefusal(identities: readonly string[], isActive: () => boolean) {
      return createSessionWorkAdmissionRefusal({
        isActive,
        install: (reason) => {
          closures.add({ identities, reason, sticky: true });
        },
        interruptPending: (reason, onError) => interruptPending(identities, reason, onError),
      });
    },
    close(identities: readonly string[], reason: Error) {
      const owner = { identities, reason };
      closures.add(owner);
      // Temporary lifecycle callers retain rollback and explicit reopening.
      try {
        interruptPending(identities, reason);
      } catch (error) {
        closures.delete(owner);
        throw error;
      }
      return () => {
        closures.delete(owner);
      };
    },
  };
}
