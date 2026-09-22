import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps SDK resolution available when a compiled Doctor callback imports its sidecar later", () => {
  const root = tempDirs.make("doctor-lazy-sdk-");
  const plugins = path.join(root, "extensions");
  const plugin = path.join(plugins, "lazy-doctor");
  fs.mkdirSync(plugin, { recursive: true });
  const tsconfig: { compilerOptions: { paths: Record<string, string[]> } } = JSON.parse(
    fs.readFileSync(path.resolve("tsconfig.json"), "utf8"),
  );
  const paths = Object.fromEntries(
    Object.entries(tsconfig.compilerOptions.paths)
      .filter(([specifier]) => !specifier.startsWith("openclaw/plugin-sdk"))
      .map(([specifier, targets]) => [specifier, targets.map((target) => path.resolve(target))]),
  );
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths } }),
  );
  fs.writeFileSync(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "@example/lazy-doctor",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  fs.writeFileSync(
    path.join(plugin, "index.mjs"),
    'export default { id: "lazy-doctor", register() {} };',
  );
  fs.writeFileSync(
    path.join(plugin, "openclaw.plugin.json"),
    JSON.stringify({
      id: "lazy-doctor",
      configSchema: {},
      doctorContract: { stateMigrations: [{ id: "lazy-state" }] },
    }),
  );
  fs.writeFileSync(
    path.join(plugin, "doctor-contract-api.mjs"),
    `export const stateMigrations = [{
    id: "lazy-state", label: "Lazy state",
    detectLegacyState: async () => ({ preview: [(await import("./sidecar.mjs")).marker] }),
    migrateLegacyState: async () => ({ changes: [], warnings: [] })
  }];`,
  );
  fs.writeFileSync(
    path.join(plugin, "sidecar.mjs"),
    'import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";\nexport const marker = definePluginEntry({ id: "host-sdk", name: "Fixture", description: "Fixture", register() {} }).id;',
  );
  const probe = path.join(root, "probe.mjs");
  fs.writeFileSync(
    probe,
    `
    const { listPluginDoctorStateMigrationEntries } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/plugins/doctor-contract-registry.ts")).href)});
    const entries = listPluginDoctorStateMigrationEntries({ config: { plugins: { allow: ["lazy-doctor"] } }, env: process.env, pluginIds: ["lazy-doctor"] });
    if (entries.length !== 1) throw new Error("Expected one declared migration");
    const result = await entries[0].migration.detectLegacyState({ config: {}, env: process.env, stateDir: process.env.OPENCLAW_STATE_DIR, oauthDir: process.env.OPENCLAW_STATE_DIR, context: { openPluginStateKeyedStore() { throw new Error("Unexpected store open"); } } });
    console.log(JSON.stringify(result));
  `,
  );
  // A plain process has no Vitest SDK alias hook to mask a missing production resolver.
  const result = spawnSync(process.execPath, ["--import", "tsx", probe], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: plugins,
      TSX_TSCONFIG_PATH: path.join(root, "tsconfig.json"),
    },
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ preview: ["host-sdk"] });
});
