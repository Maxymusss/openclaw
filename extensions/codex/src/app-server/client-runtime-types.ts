import type { CodexAppServerAuthProfileLookup } from "./auth-profile.js";
import type { CodexServiceTier } from "./protocol.js";

export type ClientRuntimeContext = CodexAppServerAuthProfileLookup & {
  authMode?: "prepared-api-key" | "profile";
  onAuthRefreshFailure?: () => void;
};

export type CodexAppServerLiveThreadOwnership = {
  assertCurrent: () => void;
  configFingerprint?: string;
  /** Ephemeral configuration is creation-owned and cannot be refreshed or cold-resumed. */
  ephemeralPolicy?: string;
  serviceTier?: CodexServiceTier | null;
  /** Releases this active claim or the exact idle record it published. */
  release: (
    threadId: string,
    assertCurrent?: () => void,
    withCurrent?: (write: () => void) => Promise<void>,
  ) => Promise<void>;
  /** Forgets this local owner after native shutdown, without unsubscribing a successor. */
  forget: () => void;
};
