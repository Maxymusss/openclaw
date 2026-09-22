import type {
  SessionCreatedActor,
  SessionMember,
  SessionMemberEvidence,
  SessionSharingIdentity,
} from "../../../packages/gateway-protocol/src/index.js";
import type { listProfiles } from "../../state/user-profiles.js";
import { buildControlUiUserAvatarPath } from "../control-ui-contract.js";

export type SharingActorFacts =
  | { state: "present"; actor: SessionSharingIdentity }
  | { state: "unknown" }
  | { state: "absent" };

const UNKNOWN_SHARING_ACTOR_STORAGE_REF = "actor-evidence:unknown";
const UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF = "actor-evidence:unattributed";
const LEGACY_SYNTHETIC_SHARING_ACTOR_STORAGE_REFS = new Set(["local-operator", "operator.admin"]);

export function sharingActorStorageRef(facts: SharingActorFacts): string {
  return facts.state === "present"
    ? facts.actor.id
    : facts.state === "unknown"
      ? UNKNOWN_SHARING_ACTOR_STORAGE_REF
      : UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF;
}

export function projectSessionMemberEvidence(member: SessionMember): SessionMemberEvidence {
  // Sentinel ids satisfy the existing non-null storage contract only. Project
  // actor evidence here so persistence markers never become protocol identities.
  const common = { identityId: member.identityId, addedAt: member.addedAt };
  if (member.addedBy === UNKNOWN_SHARING_ACTOR_STORAGE_REF) {
    return { ...common, addedByState: "unknown" };
  }
  if (
    member.addedBy === UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF ||
    LEGACY_SYNTHETIC_SHARING_ACTOR_STORAGE_REFS.has(member.addedBy)
  ) {
    // Beta builds stored fabricated operator ids before actor evidence became
    // tri-state. Discard those unshipped values instead of presenting principals.
    return common;
  }
  return { ...common, addedBy: member.addedBy };
}

export function projectLegacySessionMember(member: SessionMemberEvidence): SessionMember | null {
  if (!member.addedBy) {
    return null;
  }
  return {
    identityId: member.identityId,
    addedBy: member.addedBy,
    addedAt: member.addedAt,
  };
}

export function knownSessionIdentities(params: {
  creators: readonly SessionCreatedActor[];
  actor: SharingActorFacts;
  profiles: Awaited<ReturnType<typeof listProfiles>>;
}): SessionSharingIdentity[] {
  const identities = new Map<string, SessionSharingIdentity>();
  const remember = (identity: SessionCreatedActor | null) => {
    if (!identity?.id) {
      return;
    }
    const current = identities.get(identity.id);
    identities.set(identity.id, {
      type: identity.type,
      id: identity.id,
      ...(identity.identity ? { identity: identity.identity } : {}),
      ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
      ...((identity.label ?? current?.label) ? { label: identity.label ?? current?.label } : {}),
    });
  };
  if (params.actor.state === "present") {
    remember(params.actor.actor);
  }
  for (const creator of params.creators) {
    remember(creator);
  }
  for (const profile of params.profiles) {
    remember({
      type: "human",
      id: profile.id,
      identity: { type: "profile", id: profile.id },
      label:
        profile.displayName?.trim() ||
        profile.githubIdentity?.login ||
        profile.emails[0] ||
        profile.id,
      ...(profile.hasAvatar
        ? { avatarUrl: buildControlUiUserAvatarPath(profile.id, profile.updatedAt) }
        : {}),
    });
  }
  return [...identities.values()];
}
