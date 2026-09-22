import { onExit } from "signal-exit";
import { discoverFreeBsdService } from "../../scripts/lib/freebsd-service-discovery.mjs";
import type { GatewayServiceEnvArgs } from "./service-types.js";

export async function readFreeBsdGatewayServiceDiscovery({ timeoutMs }: GatewayServiceEnvArgs) {
  return await discoverFreeBsdService({ timeoutMs, registerExitCleanup: onExit });
}

/** Absence inspection reports service discovery only; it grants no mutation authority. */
export async function isFreeBsdGatewayServiceAbsent(args: GatewayServiceEnvArgs) {
  return (await readFreeBsdGatewayServiceDiscovery(args)).status === "absent";
}
