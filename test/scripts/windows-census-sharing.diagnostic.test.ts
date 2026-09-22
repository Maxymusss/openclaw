import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";

it("records native Windows lease sharing without claiming a historical handle owner", async () => {
  expect(process.platform, "native Windows proof required").toBe("win32");
  const selectedRuntime = process.env.OPENCLAW_VITEST_RUNTIME?.trim();
  const workerRuntime = {
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    node: process.versions.node,
    bun: process.versions.bun ?? null,
    vitestRuntime:
      selectedRuntime === "node" || selectedRuntime === "bun"
        ? selectedRuntime
        : selectedRuntime
          ? "other"
          : null,
  };
  const { child, completion } = spawnOwnedVitestProcess({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./fixtures/windows-census-sharing-probe.mjs", import.meta.url)),
      JSON.stringify(workerRuntime),
    ],
    options: { stdio: ["ignore", "pipe", "pipe"] },
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const result = await completion;
  console.log("WINDOWS_CENSUS_SHARING", stdout.trim().replaceAll(/\r?\n/gu, " "));
  expect(result, stderr).toMatchObject({ code: 0, signal: null });
  expect(stderr).toBe("");
  const evidence = JSON.parse(stdout);
  expect(evidence.platform).toBe("win32");
  expect(evidence.cells).toHaveLength(5);
  // Whole-replay descendant extinction belongs to the controller's retained Windows Job.
}, 60_000);
