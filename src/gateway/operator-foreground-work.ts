import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { assertOperatorBackgroundWorkAllowed } from "../agents/operator-foreground-work.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

/** Direct RPCs use the same original source as tools, before their first effect. */
export function authorizeOperatorBackgroundWork(
  client: Pick<GatewayClient, "internal"> | null | undefined,
): ErrorShape | undefined {
  try {
    assertOperatorBackgroundWorkAllowed({
      operatorAuthority: client?.internal?.operatorRunAuthority,
      accessAuthority: client?.internal?.operatorAccessAuthority,
    });
    return undefined;
  } catch (error) {
    return errorShape(ErrorCodes.FORBIDDEN, error instanceof Error ? error.message : String(error));
  }
}
