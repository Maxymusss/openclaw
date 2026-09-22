// Diagnostic-only native pre-open tripwire; never grants private-store acceptance.
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { threadId } = require("node:worker_threads");
const { syncBuiltinESMExports } = require("node:module");
const root = process.env.OPENCLAW_PS_DIAGNOSTIC_PRIVATE_ROOT;
if (!root || !path.isAbsolute(root) || fs.realpathSync.native(root) !== root) {
  throw new Error("Missing physically verified private diagnostic root");
}
const stat = fs.lstatSync(root);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Private root changed");
const evidence = path.join(root, `sqlite-${process.pid}-${threadId}.jsonl`);
fs.appendFileSync(evidence, JSON.stringify({ kind: "preload", pid: process.pid, threadId, root }) + "\n");
// This fixture does not need a database. Any attempted database open is a scope/isolation
// failure and is refused before native open, including :memory:. No live path is ever opened.
const sqlite = require("node:sqlite");
const NativeDatabase = sqlite.DatabaseSync;
sqlite.DatabaseSync = class DiagnosticDatabase extends NativeDatabase {
  constructor(location) {
    const target = location instanceof URL ? fileURLToPath(location) : String(location);
    fs.appendFileSync(evidence, JSON.stringify({ kind: "refused-open", pid: process.pid,
      threadId, target }) + "\n");
    throw new Error("Unexpected SQLite open in PowerShell-only diagnostic; bind through owning fixture before execution");
  }
};
syncBuiltinESMExports();
