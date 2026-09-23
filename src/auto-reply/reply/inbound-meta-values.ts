import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function stripNullBytes(value: string): string {
  return value.replaceAll("\u0000", "");
}

export function normalizePromptMetadataString(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const sanitized = stripNullBytes(normalized);
  return sanitized || undefined;
}
