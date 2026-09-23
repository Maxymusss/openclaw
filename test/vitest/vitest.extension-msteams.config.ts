// Vitest extension msteams config wires the extension msteams test shard.
import { databaseWorkerExtensionTestFiles } from "./vitest.extension-database-workers-paths.mjs";
import { msTeamsExtensionTestRoots } from "./vitest.extension-msteams-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";

export function createExtensionMsTeamsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    msTeamsExtensionTestRoots.map((root) => `${root}/**/*.test.ts`),
    {
      dir: "extensions",
      env,
      exclude: databaseWorkerExtensionTestFiles,
      name: "extension-msteams",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts", "test/f113-resources.ts"],
      execArgv: [
        ...sharedVitestConfig.test.execArgv,
        "--import",
        new URL("../../scripts/f113-resources.mjs", import.meta.url).href,
      ],
    },
  );
}

export default createExtensionMsTeamsVitestConfig();
