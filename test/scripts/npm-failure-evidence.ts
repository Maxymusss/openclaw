import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

type CaptureParams = {
  cwd: string;
  tarball: string;
  env: NodeJS.ProcessEnv;
  stderr: string | null;
  startedAt: number;
  finishedAt: number;
};

// Failure-only observation: no config loading, npm invocation, directory creation,
// cache writes or raw log output. A guessed cache location is never called selected.
export function captureNpmFailureEvidence(params: CaptureParams) {
  try {
    return capture(params);
  } catch {
    return { status: "capture-unavailable" };
  }
}

function capture(params: CaptureParams) {
  const debugName = /^\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}_\d{3}Z-debug-\d+\.log$/;
  const envValue = (name: string) =>
    Object.entries(params.env).find(([key]) => key.toLowerCase() === name)?.[1];
  const configuredCache = envValue("npm_config_cache");
  const defaultCache =
    process.platform === "win32"
      ? join(envValue("localappdata") || join(homedir(), "AppData", "Local"), "npm-cache")
      : join(homedir(), ".npm");
  const cacheCandidates = [
    ...new Set(
      [configuredCache || defaultCache].filter((value): value is string => Boolean(value)),
    ),
  ].map((value) => resolve(params.cwd, value));
  const configuredLogs = envValue("npm_config_logs_dir");
  const reported = (params.stderr ?? "")
    .slice(-16384)
    .match(
      /(?:A complete log of this run can be found in:|Log files can be found here:)\s*([^\r\n]{1,4096})/,
    )?.[1]
    ?.trim();
  const reportedFile =
    reported && isAbsolute(reported) && debugName.test(basename(reported)) ? reported : undefined;
  const logDirs = [
    ...new Set([
      ...(reportedFile ? [dirname(reportedFile)] : []),
      ...(configuredLogs ? [resolve(params.cwd, configuredLogs)] : []),
      ...cacheCandidates.map((cache) => join(cache, "_logs")),
    ]),
  ].slice(0, 4);
  const logs: object[] = [];
  const directories: object[] = [];
  let sampledFiles = 0;
  for (const directory of logDirs) {
    let entries = 0;
    let bounded = false;
    try {
      // Do not follow cache/debug directory aliases or read special files.
      if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== resolve(directory)) {
        directories.push({ path: directory, status: "alias-not-read" });
        continue;
      }
      const stream = opendirSync(directory);
      try {
        const reportedEntry =
          reportedFile && dirname(reportedFile) === directory
            ? { name: basename(reportedFile), isFile: () => true }
            : undefined;
        let first = reportedEntry;
        let entry;
        while ((entry = first ?? stream.readSync())) {
          const wasReported = Boolean(first);
          first = undefined;
          if (!wasReported && reportedEntry && entry.name === reportedEntry.name) continue;
          if (++entries > 128 || sampledFiles >= 4) {
            bounded = true;
            break;
          }
          if (!entry.isFile() || !debugName.test(entry.name)) continue;
          const file = join(directory, entry.name);
          const before = lstatSync(file);
          if (
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.mtimeMs < params.startedAt - 2000 ||
            before.mtimeMs > params.finishedAt + 2000
          )
            continue;
          const fd = openSync(file, "r");
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) continue;
            sampledFiles++;
            const prefix = Buffer.alloc(Math.min(stat.size, 8192));
            const prefixRead = readSync(fd, prefix, 0, prefix.length, 0);
            const tailOffset = Math.max(prefixRead, stat.size - 8192);
            const tail = Buffer.alloc(Math.min(8192, Math.max(0, stat.size - tailOffset)));
            const tailRead = readSync(fd, tail, 0, tail.length, tailOffset);
            const prefixBytes = prefix.subarray(0, prefixRead);
            const tailBytes = tail.subarray(0, tailRead);
            // Drop incomplete boundary lines; only exact numeric/version/code fields leave this reader.
            const lines = [
              ...prefixBytes.toString("utf8").split(/\r?\n/).slice(0, -1),
              ...tailBytes.toString("utf8").split(/\r?\n/).slice(1, -1),
            ];
            const cwdMatches = lines.some(
              (line) =>
                /^\d+ verbose cwd /.test(line) &&
                line.replace(/^\d+ verbose cwd /, "") === params.cwd,
            );
            // A killed npm may never write its final cwd record. Its argv contains
            // this fixture's unique tarball even when stderr has no log pointer.
            const tarballMatches = lines.some(
              (line) =>
                /^\d+ verbose argv "install" /.test(line) &&
                line.includes(JSON.stringify(params.tarball)),
            );
            const emittedByChild = file === reportedFile;
            if (!cwdMatches && !tarballMatches && !emittedByChild) continue;
            const fields = lines
              .filter((line) =>
                /^\d+ (?:(?:verbose|error) (?:exit|errno) -?\d+|error code E[A-Z0-9_]+|verbose (?:node|npm) v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?|info using (?:npm|node)@v?\d+\.\d+\.\d+)\s*$/.test(
                  line,
                ),
              )
              .slice(-24);
            logs.push({
              path: file,
              realPath: realpathSync(file),
              bytes: stat.size,
              mtimeMs: stat.mtimeMs,
              identity: { dev: stat.dev, ino: stat.ino },
              binding: emittedByChild ? "child-stderr" : "unique-fixture-path-and-time-window",
              cwdMatches,
              tarballMatches,
              fields,
              sampledBytes: prefixRead + tailRead,
              sampleSha256: createHash("sha256")
                .update(prefixBytes)
                .update(tailBytes)
                .digest("hex"),
              complete: prefixRead + tailRead === stat.size,
              // logs-dir can be overridden independently; its parent is not proof of selected cache.
              cacheCandidate: cacheCandidates.find((cache) => join(cache, "_logs") === directory),
            });
          } finally {
            closeSync(fd);
          }
        }
      } finally {
        stream.closeSync();
      }
      directories.push({ path: directory, status: "read", entries, bounded });
    } catch {
      directories.push({ path: directory, status: "unavailable", entries });
    }
  }
  return {
    status: logs.length ? "matched-debug-evidence" : "no-matched-debug-evidence",
    cacheSelection: "unverified-config-precedence",
    cacheCandidates: cacheCandidates.map((path) => {
      try {
        const stat = lstatSync(path);
        return {
          path,
          realPath: realpathSync(path),
          isDirectory: stat.isDirectory(),
          isSymbolicLink: stat.isSymbolicLink(),
          dev: stat.dev,
          ino: stat.ino,
        };
      } catch {
        return { path, status: "unavailable" };
      }
    }),
    directories,
    logs,
    limits: { directories: 4, entriesPerDirectory: 128, files: 4, bytesPerFile: 16384 },
  };
}
