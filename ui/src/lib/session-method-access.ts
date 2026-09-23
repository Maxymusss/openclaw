import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import {
  resolveBaseSessionMutationRequiredScope,
  resolveSessionMethodScope,
  type SessionMutationOperatorScope,
} from "../../../src/shared/session-method-scopes-base.js";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";

type SessionMethodOperatorScope = "operator.read" | SessionMutationOperatorScope;

export type SessionMethodAccess =
  | { allowed: true; requiredScope: SessionMethodOperatorScope }
  | {
      allowed: false;
      requiredScope: SessionMethodOperatorScope;
      reason: string;
      cause: "disconnected" | "method-unavailable" | "missing-scope";
    };

type SessionMethodAccessRequest = {
  method: string;
  params?: unknown;
  requiredScope?: SessionMethodOperatorScope;
};

function sessionMethodAccessReason(
  cause: Exclude<SessionMethodAccess, { allowed: true }>["cause"],
  requiredScope: SessionMethodOperatorScope,
): string {
  if (cause === "disconnected") {
    return t("sessionsView.actionRequiresConnection");
  }
  if (cause === "method-unavailable") {
    return t("sessionsView.actionUnavailable");
  }
  return t(
    requiredScope === "operator.admin"
      ? "sessionsView.actionRequiresAdmin"
      : requiredScope === "operator.write"
        ? "sessionsView.actionRequiresWrite"
        : "sessionsView.actionRequiresRead",
  );
}

/**
 * Resolves browser-safe shared mutation policy or a caller-supplied placement
 * scope, plus connection and advertised-method state.
 */
export function readSessionMethodAccess(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> | null | undefined,
  request: SessionMethodAccessRequest,
): SessionMethodAccess {
  const requiredScope =
    request.requiredScope === "operator.admin"
      ? "operator.admin"
      : (resolveBaseSessionMutationRequiredScope(request.method, request.params) ??
        request.requiredScope);
  if (!requiredScope) {
    throw new Error(`Missing required scope for session mutation method: ${request.method}`);
  }
  const cause =
    snapshot?.phase !== "connected" || !snapshot.client
      ? "disconnected"
      : isGatewayMethodAdvertised(snapshot, request.method) !== true
        ? "method-unavailable"
        : "missing-scope";
  if (cause === "missing-scope") {
    const auth = snapshot?.hello?.auth;
    const scopes = auth?.scopes;
    const sessionScope =
      requiredScope !== "operator.admin"
        ? resolveSessionMethodScope(request.method, request.params)
        : undefined;
    if (
      auth &&
      Array.isArray(scopes) &&
      [requiredScope, sessionScope].some(
        (scope) =>
          scope !== undefined &&
          roleScopesAllow({ role: auth.role, requestedScopes: [scope], allowedScopes: scopes }),
      )
    ) {
      return { allowed: true, requiredScope };
    }
  }
  return {
    allowed: false,
    requiredScope,
    reason: sessionMethodAccessReason(cause, requiredScope),
    cause,
  };
}
