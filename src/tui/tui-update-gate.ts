import { runCliRespawnPlan } from "../entry.respawn.js";
import {
  announceLocalTuiClient,
  waitForLocalTuiUpdate,
  type LocalTuiUpdateAnnouncement,
} from "../infra/local-tui-processes.js";
import { formatOpenClawProcessTitle } from "../infra/openclaw-installation-id.js";
import {
  resolveOpenClawPackageRootSync,
  rewritePnpmVersionedOpenClawEntryPath,
} from "../infra/openclaw-root.js";

async function respawnTuiFromCurrentInstallation(): Promise<never> {
  const [entryArg, ...entryArgs] = process.argv.slice(1);
  runCliRespawnPlan({
    command: process.execPath,
    argv: [
      ...process.execArgv,
      ...(entryArg ? [rewritePnpmVersionedOpenClawEntryPath(entryArg)] : []),
      ...entryArgs,
    ],
    env: { ...process.env },
    detachForProcessTree: false,
  });
  // The attached child now owns this terminal. Keep the stale parent alive only
  // to bridge its signals and exit status; it must never import replaced chunks.
  return await new Promise<never>(() => {});
}

/** Loads the TUI graph only after this installation is no longer being replaced. */
async function loadTuiAfterUpdateGate(): Promise<{
  tui: typeof import("./tui.js");
  announcement?: LocalTuiUpdateAnnouncement;
}> {
  const targetRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
  });
  if (!targetRoot) {
    throw new Error("Unable to identify this OpenClaw installation before TUI startup.");
  }
  // Internal resume and setup paths do not pass through the CLI entry title setup.
  // Bind every client here, at the shared boundary that owns the resolved installation.
  process.title = formatOpenClawProcessTitle("openclaw-tui", targetRoot);
  const announcement =
    process.platform === "win32" ? await announceLocalTuiClient(targetRoot) : undefined;
  try {
    const { waitedForUpdate } = await waitForLocalTuiUpdate(targetRoot);
    if (waitedForUpdate) {
      await announcement?.release();
      return await respawnTuiFromCurrentInstallation();
    }
    return { tui: await import("./tui.js"), announcement };
  } catch (error) {
    await announcement?.release();
    throw error;
  }
}

export async function withTuiAfterUpdateGate<T>(
  run: (tui: typeof import("./tui.js")) => Promise<T>,
): Promise<T> {
  const { tui, announcement } = await loadTuiAfterUpdateGate();
  try {
    return await run(tui);
  } finally {
    await announcement?.release();
  }
}

export async function runTuiAfterUpdateGate(
  options: Parameters<typeof import("./tui.js").runTui>[0],
): ReturnType<typeof import("./tui.js").runTui> {
  return await withTuiAfterUpdateGate(async ({ runTui }) => await runTui(options));
}
