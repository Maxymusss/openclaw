import fs from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const directory = process.env.OPENCLAW_TEST_DOCTOR_HANDOFF_DIR;
if (!directory || !path.isAbsolute(directory)) {
  throw new Error("Doctor native helper requires a fixture-owned handoff directory");
}
const root = fs.realpathSync(directory);
const expected = path.join(root, "managed-update-handoffs.sqlite");
const sourceTmpResolver = fileURLToPath(new URL("../infra/tmp-openclaw-dir.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const entry = process.argv[1] && path.resolve(process.argv[1]);
const artifactRoot = path.join(repoRoot, ".artifacts", "vitest-workers") + path.sep;
const distMarker = `${path.sep}dist${path.sep}`;
const distIndex = entry?.indexOf(distMarker, artifactRoot.length);
const compiledRoot =
  entry?.startsWith(artifactRoot) && distIndex !== undefined && distIndex >= 0
    ? entry.slice(0, distIndex + distMarker.length)
    : undefined;
const tmpResolver = compiledRoot
  ? path.join(compiledRoot, "infra", "tmp-openclaw-dir.js")
  : sourceTmpResolver;
const handoffModule = compiledRoot
  ? path.join(compiledRoot, "infra", "update-managed-service-handoff-lease.js")
  : fileURLToPath(new URL("../infra/update-managed-service-handoff-lease.ts", import.meta.url));
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && [sourceTmpResolver, tmpResolver].includes(fileURLToPath(url))) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export const DEFAULT_POSIX_TMP_ROOT = ${JSON.stringify(root)};
          export function resolvePreferredOpenClawTmpDir() { return DEFAULT_POSIX_TMP_ROOT; }`,
      };
    }
    const loaded = nextLoad(url, context);
    if (
      compiledRoot &&
      url.startsWith("file:") &&
      path.dirname(fileURLToPath(url)) === path.resolve(compiledRoot) &&
      /^tmp-openclaw-dir-[^/]+\.js$/u.test(path.basename(fileURLToPath(url)))
    ) {
      const source =
        typeof loaded.source === "string"
          ? loaded.source
          : Buffer.from(loaded.source).toString("utf8");
      if (!source.includes("function resolvePreferredOpenClawTmpDir(")) {
        throw new Error("Compiled helper temp resolver cannot be isolated");
      }
      // The compiler aliases exports; replace the resolver binding, preserving
      // the emitted module's exports and every other dependency unchanged.
      return {
        ...loaded,
        source: source + `\nresolvePreferredOpenClawTmpDir = () => ${JSON.stringify(root)};\n`,
      };
    }
    return loaded;
  },
});

// Reject an escaped store before native SQLite can open or create it.
const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite");
const NativeDatabase = sqlite.DatabaseSync;
const GuardedDatabase = new Proxy(NativeDatabase, {
  construct(target, args, newTarget) {
    const location = String(args[0]);
    if (location.includes("managed-update-handoffs.sqlite")) {
      const pathname = location.startsWith("file:")
        ? fileURLToPath(location)
        : path.resolve(location);
      if (
        path.basename(pathname) !== path.basename(expected) ||
        fs.realpathSync(path.dirname(pathname)) !== root
      ) {
        fs.appendFileSync(
          path.join(root, "blocked-native-opens.jsonl"),
          JSON.stringify({ location }) + "\n",
        );
        throw new Error("Doctor native helper attempted a non-private handoff store");
      }
    }
    return Reflect.construct(target, args, newTarget === GuardedDatabase ? target : newTarget);
  },
});
sqlite.DatabaseSync = GuardedDatabase;
syncBuiltinESMExports();

// tsImport creates a loader thread that inherits this preload. Only the actual
// helper thread performs the readback, before Node enters its main module.
if (isMainThread) {
  const { resolveManagedUpdateLeaseDatabasePath } = compiledRoot
    ? await import(pathToFileURL(handoffModule).href)
    : await (
        await import("tsx/esm/api")
      ).tsImport(handoffModule, {
        parentURL: import.meta.url,
        tsconfig: path.join(repoRoot, "tsconfig.json"),
      });
  const resolved = resolveManagedUpdateLeaseDatabasePath();
  const canonicalParent = fs.realpathSync(path.dirname(resolved));
  if (resolved !== expected || canonicalParent !== root) {
    throw new Error("Doctor native helper resolved a non-private handoff store");
  }
  fs.appendFileSync(
    path.join(root, "helper-resolvers.jsonl"),
    JSON.stringify({
      pid: process.pid,
      argv: process.argv,
      resolved,
      canonicalParent,
      handoffModule,
    }) + "\n",
  );
}
