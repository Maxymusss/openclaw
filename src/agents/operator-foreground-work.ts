import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { readOperatorExecutionPolicy } from "../shared/operator-execution-policy.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { runWithOperatorModelRequest } from "./operator-model-policy.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

class OperatorForegroundWorkError extends Error {
  constructor() {
    super(
      "This access permits one foreground turn only. Finish this turn and ask the user for a new request; background or resumed work is unavailable.",
    );
    this.name = "OperatorForegroundWorkError";
  }
}

/** Read the original host-held restriction, including direct plugin requests. */
export function isOperatorForegroundWork(source?: {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  accessAuthority?: PluginGatewayAccessAuthority | null;
}): boolean {
  const scope = getPluginRuntimeGatewayRequestScope();
  const caller = getGatewayToolCallerIdentity();
  const authorities = new Set([
    // Isolated/provider callbacks retain model authority without a Gateway/tool source.
    runWithOperatorModelRequest(undefined, (authority) => authority),
    source?.operatorAuthority,
    caller?.operatorAuthority,
    scope?.client?.internal?.operatorRunAuthority,
  ]);
  for (const authority of authorities) {
    if (authority) {
      assertAdmittedRunOperatorAuthority(authority);
      authority.assertCurrent();
      if (readOperatorExecutionPolicy(authority.executionPolicy)) {
        return true;
      }
    }
  }
  // Direct plugin requests can precede run admission; their authenticated access
  // source still restricts producers that bypass a model-mediated tool call.
  for (const access of new Set([
    source?.accessAuthority,
    scope?.client?.internal?.operatorAccessAuthority,
  ])) {
    access?.assertCurrent();
    if (readOperatorExecutionPolicy(access?.executionPolicy)) {
      return true;
    }
  }
  return false;
}

/** Check before reserving a child, queue, schedule, or continuation, not during settlement. */
export function assertOperatorBackgroundWorkAllowed(
  source?: Parameters<typeof isOperatorForegroundWork>[0],
): void {
  if (isOperatorForegroundWork(source)) {
    throw new OperatorForegroundWorkError();
  }
}
