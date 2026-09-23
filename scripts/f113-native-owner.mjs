// Replays nodejs/node#61999, with joined-server and Wasm-scheduling controls.
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "child") {
  const server = http.createServer((_request, response) => {
    response.writeHead(302, { location: "/" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let rejectedRedirect = false;
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/`);
  } catch (error) {
    rejectedRedirect = error?.cause?.message === "redirect count exceeded";
  }
  if (process.argv[3] === "joined") {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  writeSync(
    1,
    JSON.stringify({
      stage: "F113_OWNER_READY",
      rejectedRedirect,
      resources: process.getActiveResourcesInfo(),
    }) + "\n",
  );
  process.exit(rejectedRedirect ? 0 : 2);
}

if (process.platform !== "win32" || process.versions.node !== process.env.F113_NODE_VERSION) {
  throw new Error("Native owner probe runtime differs from binding");
}
const root = path.resolve(".artifacts/f113");
mkdirSync(root, { recursive: true });
writeFileSync(
  path.join(root, "identity.json"),
  JSON.stringify(
    {
      node: process.versions.node,
      source: process.env.GITHUB_SHA,
      platform: process.platform,
      arch: process.arch,
    },
    null,
    2,
  ) + "\n",
);
const results = [];
for (const stress of [false, true]) {
  for (const cleanup of ["original", "joined"]) {
    const flags = stress ? ["--wasm-caching-threshold=1", "--wasm-tiering-budget=1"] : [];
    for (let index = 1; index <= 100; index++) {
      const name = `${stress ? "stress" : "default"}-${cleanup}-${index}`;
      const logPath = path.join(root, `${name}.log`);
      const descriptor = openSync(logPath, "w");
      const result = spawnSync(
        process.execPath,
        [...flags, fileURLToPath(import.meta.url), "child", cleanup],
        {
          stdio: ["ignore", descriptor, descriptor],
          env: { ...process.env, NODE_DEBUG_NATIVE: "PLATFORM_MINIMAL" },
        },
      );
      closeSync(descriptor);
      const log = readFileSync(logPath, "utf8");
      const row = {
        name,
        flags,
        code: result.status,
        signal: result.signal,
        error: result.error?.message,
        reachedExit: log.includes('"stage":"F113_OWNER_READY"'),
        rejectedRedirect: log.includes('"rejectedRedirect":true'),
        closingAsyncAssertion: log.includes("!(handle->flags & UV_HANDLE_CLOSING)"),
      };
      results.push(row);
      writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2) + "\n");
      console.log(JSON.stringify(row));
      if (result.error) throw result.error;
      if (!row.reachedExit || !row.rejectedRedirect)
        throw new Error(`Invalid owner probe: ${name}`);
    }
  }
}
process.exitCode = results.some((row) => row.code !== 0) ? 1 : 0;
