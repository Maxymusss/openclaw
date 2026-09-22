import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function snapshotFixture(file) {
  try {
    const bytes = fs.readFileSync(file);
    return { exists: true, bytes: bytes.length, bomHex: bytes.subarray(0, 2).toString("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    return { exists: false, errorCode: error.code ?? "UNKNOWN" };
  }
}

// The control caller supplies a real child. The production call keeps execFileSync and its 10s budget.
export function observeFixtureCall(executable, args, options, emit) {
  const started = performance.now();
  let output;
  let failure;
  try {
    output = execFileSync(executable, args, options);
    return output;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const stderr = failure?.stderr?.toString() ?? "";
    emit({ kind: "powershell-fixture-boundary", elapsedMs: performance.now() - started,
      status: failure ? failure.status ?? null : 0, signal: failure?.signal ?? null,
      errorCode: failure?.code ?? null, childPid: failure?.pid ?? null,
      engineEntry: failure ? stderr.includes("OC_PS_ENGINE_ENTRY") : null,
      outFileCompleted: failure ? stderr.includes("OC_PS_OUTFILE_COMPLETE") : null,
      fixture: snapshotFixture(path.join(options.cwd, "utf16.txt")),
      // Successful execFileSync writes stderr through by default; marker booleans above are failure-only.
      markerBooleansScope: failure ? "captured-failure-stderr" : "see-inherited-stderr",
    });
  }
}

export async function observePowerShellFixture(executable, workspaceDir) {
  const monitor = path.join(workspaceDir, "process-observation");
  fs.mkdirSync(monitor);
  const ready = path.join(monitor, "ready");
  const stop = path.join(monitor, "stop");
  const output = path.join(monitor, "samples.json");
  const child = spawn("python", [
    fileURLToPath(new URL("./powershell-process-observer.py", import.meta.url)),
    String(process.pid), ready, stop, output,
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let spawnFailure;
  // Never emit process arguments, environment or arbitrary stderr.
  child.on("error", error => { spawnFailure = error.code ?? "UNKNOWN"; });
  child.stdout.resume();
  child.stderr.resume();
  const settled = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    const deadline = performance.now() + 5000;
    while (!fs.existsSync(ready) && spawnFailure === undefined && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!fs.existsSync(ready)) throw new Error("Private process observer failed to become ready");
    return observeFixtureCall(executable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::Error.WriteLine('OC_PS_ENGINE_ENTRY'); " +
      "@('first', 'second') | Out-File -LiteralPath 'utf16.txt'; " +
      "if ($?) { [Console]::Error.WriteLine('OC_PS_OUTFILE_COMPLETE') } " +
      "else { [Console]::Error.WriteLine('OC_PS_OUTFILE_FAILED'); exit 1 }",
    ], { cwd: workspaceDir, timeout: 10_000, windowsHide: true },
    record => console.error(JSON.stringify(record)));
  } finally {
    fs.writeFileSync(stop, "");
    const completed = await Promise.race([
      settled,
      new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), 3000);
        settled.then(() => clearTimeout(timer));
      }),
    ]);
    if (completed === null) {
      child.kill();
      await settled;
    }
    const samples = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : null;
    console.error(JSON.stringify({ kind: "powershell-live-process", observer: await settled,
      spawnFailure: spawnFailure ?? null, samples }));
  }
}
