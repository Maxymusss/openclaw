import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import path from "node:path";

const files = JSON.parse(readFileSync(new URL("./f113-files.json", import.meta.url), "utf8"));
const root = path.resolve(".artifacts/f113");
mkdirSync(root, { recursive: true });
const rows = [];
// Fixed cohorts retain failures; no failed sample is retried or replaced.
for (const [kind, count, targets] of [
  ["shard", 5, files],
  ["alone", 10, ["extensions/msteams/src/messenger.test.ts"]],
]) {
  for (let index = 1; index <= count; index++) {
    const evidence = path.join(root, `${kind}-${index}`);
    mkdirSync(evidence, { recursive: true });
    const args = [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/test-projects.mts",
      ...targets,
      "--fileParallelism",
      "--reporter=verbose",
    ];
    const fd = openSync(path.join(evidence, "run.log"), "w");
    const started = Date.now();
    console.log(JSON.stringify({ event: "start", kind, index, args }));
    const result = spawnSync(process.execPath, args, {
      stdio: ["ignore", fd, fd],
      env: { ...process.env, F113_EVIDENCE: evidence },
    });
    closeSync(fd);
    const row = {
      kind,
      index,
      code: result.status,
      signal: result.signal,
      error: result.error?.message,
      seconds: (Date.now() - started) / 1000,
    };
    rows.push(row);
    writeFileSync(path.join(root, "results.json"), JSON.stringify(rows, null, 2) + "\n");
    console.log(JSON.stringify({ event: "result", ...row }));
    if (result.error) throw result.error;
    if (result.status !== 0)
      console.log(readFileSync(path.join(evidence, "run.log"), "utf8").slice(-16000));
  }
}
process.exitCode = rows.some((row) => row.code !== 0) ? 1 : 0;
