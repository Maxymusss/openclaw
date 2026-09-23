import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "../../src/infra/replace-file.ts";

/**
 * Writes a generated text asset only when its contents changed.
 */
export async function writeGeneratedTextAsset(filePath: string, contents: string) {
  let currentContents = null;
  try {
    currentContents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  if (currentContents === contents) {
    return false;
  }

  await replaceFileAtomic({
    filePath,
    content: contents,
    dirMode: 0o777 & ~process.umask(),
    mode: 0o666 & ~process.umask(),
    syncParentDir: false,
    syncTempFile: false,
    tempPrefix: path.basename(filePath),
  });
  return true;
}
