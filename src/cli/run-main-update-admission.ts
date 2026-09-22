import { getCommandArgsWithRootOptions } from "../infra/cli-root-options.js";
import type { resolveCliArgvInvocation } from "./argv-invocation.js";

/** Only the internal command owns the early read-only boundary; help follows normal startup. */
export function isUpdateAdmissionInvocation(
  invocation: ReturnType<typeof resolveCliArgvInvocation>,
): boolean {
  return (
    !invocation.hasHelpOrVersion &&
    invocation.commandPath.length === 2 &&
    invocation.commandPath[0] === "update" &&
    invocation.commandPath[1] === "admit" &&
    getCommandArgsWithRootOptions(invocation.argv, {
      commandPath: ["update", "admit"],
      mode: "command-path",
    })?.length === 0
  );
}

/** Reject inherited update authority before general CLI startup can write diagnostics. */
export async function tryRunUpdateAdmissionBeforeStartup(
  invocation: ReturnType<typeof resolveCliArgvInvocation>,
): Promise<boolean> {
  if (!isUpdateAdmissionInvocation(invocation)) {
    return false;
  }
  const { updateAdmitCommand } = await import("./update-cli/update-command-admit.js");
  await updateAdmitCommand();
  return true;
}
