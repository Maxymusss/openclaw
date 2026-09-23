import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Names attached to one model entry, including during pre-validation Doctor inspection. */
export function getConfiguredModelAliases(
  entry: { alias?: unknown; aliases?: unknown } | undefined,
): string[] {
  const names = [entry?.alias, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])];
  const seen = new Set<string>();
  return names.flatMap((name) => {
    const trimmed = normalizeOptionalString(name);
    const key = trimmed?.toLowerCase();
    if (!trimmed || !key || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [trimmed];
  });
}
