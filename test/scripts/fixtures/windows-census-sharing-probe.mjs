// Run only on the authorized native Windows proof host; creates synthetic files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

assert.equal(process.platform, "win32", "native Windows proof required");
const workerRuntime = JSON.parse(process.argv[2]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "census-lease-probe-"));
const python = String.raw`
import ctypes as c, json, os, pathlib, platform, sys
root, mode = pathlib.Path(sys.argv[1]), sys.argv[2]
target, replacement = root / "lease", root / "lease-replacement"
handle = None
kernel = None
try:
    if mode == "deny-delete-reader":
        from ctypes import wintypes as w
        kernel = c.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.restype = w.HANDLE
        kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
        kernel.CloseHandle.argtypes = [w.HANDLE]
        kernel.CloseHandle.restype = w.BOOL
        handle = kernel.CreateFileW(str(target), 0x80000000, 3, None, 3, 0x80, None)
        if handle == c.c_void_p(-1).value:
            raise c.WinError(c.get_last_error())
    try:
        replacement.replace(target)
        result = dict(replaced=True)
    except OSError as error:
        result = dict(replaced=False, winerror=error.winerror, errno=error.errno)
    result.update(python=platform.python_version(), pythonExecutable=sys.executable, contents=target.read_text())
    print(json.dumps(result), flush=True)
finally:
    if handle is not None and kernel is not None:
        if not kernel.CloseHandle(handle):
            raise c.WinError(c.get_last_error())
`;
const cells = [];
try {
  for (const mode of [
    "no-reader",
    "node-read-handle",
    "node-read-after-read",
    "deny-delete-reader",
  ]) {
    const directory = fs.mkdtempSync(path.join(root, "cell-"));
    const lease = path.join(directory, "lease");
    fs.writeFileSync(lease, "original");
    fs.writeFileSync(path.join(directory, "lease-replacement"), "replacement");
    let reader;
    try {
      if (mode.startsWith("node-read")) {
        reader = fs.openSync(lease, "r");
        if (mode === "node-read-after-read") fs.readSync(reader, Buffer.alloc(8), 0, 8, 0);
      }
      const result = spawnSync("python", ["-I", "-S", "-c", python, directory, mode], {
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      cells.push({
        mode,
        ...JSON.parse(result.stdout),
        child: { pid: result.pid, exitCode: result.status, signal: result.signal },
      });
    } finally {
      if (reader !== undefined) fs.closeSync(reader);
    }
  }
  const directory = fs.mkdtempSync(path.join(root, "sync-writer-"));
  const lease = path.join(directory, "lease");
  fs.writeFileSync(lease, "original");
  const reader = fs.openSync(lease, "r");
  try {
    fs.writeFileSync(lease, "replacement");
    cells.push({
      mode: "supervisor-sync-write-with-node-reader",
      contents: fs.readFileSync(lease, "utf8"),
    });
  } finally {
    fs.closeSync(reader);
  }
  const executableSha256 = createHash("sha256")
    .update(fs.readFileSync(process.execPath))
    .digest("hex");
  const selectedRuntime = process.env.OPENCLAW_VITEST_RUNTIME?.trim();
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        release: os.release(),
        node: process.version,
        cells,
        runtime: {
          worker: {
            ...workerRuntime,
            executableSha256:
              workerRuntime.execPath === process.execPath
                ? executableSha256
                : createHash("sha256")
                    .update(fs.readFileSync(workerRuntime.execPath))
                    .digest("hex"),
          },
          probe: {
            pid: process.pid,
            ppid: process.ppid,
            execPath: process.execPath,
            node: process.versions.node,
            bun: process.versions.bun ?? null,
            executableSha256,
            vitestRuntime:
              selectedRuntime === "node" || selectedRuntime === "bun"
                ? selectedRuntime
                : selectedRuntime
                  ? "other"
                  : null,
          },
        },
      },
      null,
      2,
    ),
  );
  assert(
    cells.slice(0, 4).every((cell) => cell.python === "3.12.10"),
    "qualified Python 3.12.10 required",
  );
  assert.equal(cells[0].replaced, true, "uncontended original replacement control");
  assert.equal(cells[3].replaced, false, "native delete-sharing refusal control");
  assert.equal(cells[3].winerror, 5, "same WinError class as retained CI failure");
  assert.equal(cells[4].contents, "replacement", "candidate writer with actual Node reader");
} finally {
  fs.rmSync(root, { recursive: true });
}
