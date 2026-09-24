import { isDeepStrictEqual } from "node:util";
import { resolveRequestedSessionAgentInput } from "./session-request-agent.js";
import { withSessionSharingTarget } from "./session-sharing-policy.js";
import { resolveDirectSessionTargets } from "./session-sharing-target-input.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";

/** Read participation in the worker while retaining its owner through authorization. */
export async function resolveSessionMutationAuthorizationAsync(
  params: Parameters<typeof resolveSessionMutationAuthorization>[0],
) {
  const targets = resolveDirectSessionTargets(params.method, params.requestParams);
  if (params.method !== "chat.send" || targets.length !== 1) {
    return resolveSessionMutationAuthorization(params);
  }
  const target = targets[0]!;
  const input = resolveRequestedSessionAgentInput(target.sessionKey, target.agentId);
  if (!input.ok) {
    return { error: input.error };
  }
  const cfg = params.context.getRuntimeConfig();
  return withSessionSharingTarget(
    { cfg, sessionKey: target.sessionKey, agentId: input.value },
    (read) => {
      const assertCurrent = () => {
        read.assertCurrent();
        if (!isDeepStrictEqual(cfg, params.context.getRuntimeConfig())) {
          throw new Error("Session routing changed during authorization read");
        }
      };
      assertCurrent();
      return resolveSessionMutationAuthorization({
        ...params,
        preparedSharing: { ...read, assertCurrent },
      });
    },
  );
}
