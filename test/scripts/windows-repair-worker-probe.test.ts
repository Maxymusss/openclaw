import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  loadPackagedOwner,
  type PackagedOwnerEvidence,
} from "../../scripts/lib/windows-repair-package.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

async function fixture(files: Record<string, string>) {
  const root = directories.make("windows-repair-package-owner-");
  const packageRoot = path.join(root, "package");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(packageRoot, "dist", name), contents);
  }
  const tarball = path.join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  return { packageRoot, tarball };
}

it.each(["a", "$"])(
  "loads the named package owner through authenticated alias %s",
  async (alias) => {
    const contents = `function admit() { return "owned"; } export { admit as ${alias} };`;
    const { packageRoot, tarball } = await fixture({ "executor-fixture.mjs": contents });
    const evidence: PackagedOwnerEvidence[] = [];
    const owner = await loadPackagedOwner(packageRoot, tarball, "executor", ["admit"], evidence);
    expect(owner.admit?.()).toBe("owned");
    expect(evidence).toEqual([
      {
        file: "dist/executor-fixture.mjs",
        sha256: createHash("sha256").update(contents).digest("hex"),
        exports: { admit: alias },
      },
    ]);
  },
);

it("refuses changed installed authority before importing its executable module", async () => {
  const { packageRoot, tarball } = await fixture({
    "executor-fixture.mjs": "function admit() {} export { admit as a };",
  });
  await fs.writeFile(
    path.join(packageRoot, "dist", "executor-fixture.mjs"),
    'throw new Error("unverified code executed"); function admit() {} export { admit as a };',
  );
  await expect(loadPackagedOwner(packageRoot, tarball, "executor", ["admit"], [])).rejects.toThrow(
    "Installed module differs from the bound package",
  );
});

it.each(["absent", "ambiguous"])("refuses an %s packaged authority owner", async (shape) => {
  const files: Record<string, string> =
    shape === "absent"
      ? { "executor-other.mjs": "function different() {} export { different as a };" }
      : {
          "executor-first.mjs": "function admit() {} export { admit as a };",
          "executor-second.mjs": "function admit() {} export { admit as b };",
        };
  const { packageRoot, tarball } = await fixture(files);
  await expect(loadPackagedOwner(packageRoot, tarball, "executor", ["admit"], [])).rejects.toThrow(
    "Expected one packaged executor owner",
  );
});
