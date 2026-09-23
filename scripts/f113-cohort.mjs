import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

if (process.platform !== "win32" || process.versions.node !== process.env.F113_NODE_VERSION) {
  throw new Error("Native runtime differs from workflow binding");
}
const root = path.resolve(".artifacts/f113");
mkdirSync(root, { recursive: true });
writeFileSync(
  path.join(root, "identity.json"),
  JSON.stringify(
    {
      source: process.env.GITHUB_SHA,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      workers: process.env.OPENCLAW_VITEST_MAX_WORKERS,
    },
    null,
    2,
  ) + "\n",
);
const rows = [];
for (const mode of ["normal", "wasm-stress"]) {
  for (let index = 1; index <= 20; index++) {
    const evidence = path.join(root, `${mode}-${index}`);
    mkdirSync(evidence, { recursive: true });
    console.log(JSON.stringify({ event: "start", mode, index }));
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/test-projects.mts",
        "extensions/msteams/src/messenger.test.ts",
        "--fileParallelism",
        "--reporter=verbose",
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          NODE_DEBUG_NATIVE: "",
          F113_EVIDENCE: evidence,
          F113_WASM_STRESS: mode === "wasm-stress" ? "1" : "0",
        },
      },
    );
    const row = {
      mode,
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
    const reachedAfterAll = readdirSync(evidence)
      .filter((name) => name.endsWith(".jsonl"))
      .some((name) =>
        readFileSync(path.join(evidence, name), "utf8")
          .trim()
          .split("\n")
          .some((line) => {
            const phase = JSON.parse(line).phase.replaceAll("\\", "/");
            return (
              phase.startsWith("afterAll:") &&
              phase.endsWith("/extensions/msteams/src/messenger.test.ts")
            );
          }),
      );
    if (!reachedAfterAll) throw new Error("Target did not reach afterAll; stop invalid cohort");
  }
}
process.exitCode = rows.some((row) => row.code !== 0) ? 1 : 0;
