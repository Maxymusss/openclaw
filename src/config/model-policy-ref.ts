import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { getConfiguredModelAliases } from "./model-aliases.js";
import { normalizeAgentModelRefForConfig } from "./model-input.js";

const MODEL_POLICY_COMPAT_SELECTORS = new Set(["openrouter:auto", "openrouter:free"]);

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasValidSegments(
  segments: readonly string[],
  bounds: { min: number; max?: number },
): boolean {
  return (
    segments.length >= bounds.min &&
    (bounds.max === undefined || segments.length <= bounds.max) &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        !segment.includes("*") &&
        !/\s/u.test(segment) &&
        !hasControlCharacter(segment),
    )
  );
}

type ModelPolicyWildcardRef = {
  key: string;
  provider: string;
};

/** Parse and canonicalize a segment-boundary model-policy prefix wildcard. */
export function parseModelPolicyWildcardRef(raw: string): ModelPolicyWildcardRef | null {
  const trimmed = raw.trim();
  // Wildcard keys match on segment boundaries, so normalize boundary padding
  // before building the canonical key used by policy matching.
  const segments = trimmed.split("/").map((segment) => segment.trim());
  if (
    segments.at(-1) !== "*" ||
    !hasValidSegments(segments.slice(0, -1), {
      min: 1,
    })
  ) {
    return null;
  }
  const provider = normalizeProviderId(segments[0] ?? "");
  if (!provider) {
    return null;
  }
  return {
    key: [provider, ...segments.slice(1)].join("/"),
    provider,
  };
}

/** Role-only model prefixes do not widen the segment grammar used by agent/UI policies. */
export function parseOperatorModelPolicyWildcardRef(raw: string): ModelPolicyWildcardRef | null {
  const wildcard = parseModelPolicyWildcardRef(raw);
  if (wildcard) {
    return wildcard;
  }
  const trimmed = raw.trim();
  const literal = trimmed.slice(0, -1);
  if (!trimmed.endsWith("*") || !literal.includes("/") || /\s$/u.test(literal)) {
    return null;
  }
  // Validate the literal prefix with the same segment owner, then remove its synthetic separator.
  const prefix = parseModelPolicyWildcardRef(`${literal}/*`);
  return prefix ? { ...prefix, key: `${prefix.key.slice(0, -2)}*` } : null;
}

/** True for a syntactically valid exact provider/model policy reference. */
function isValidExactModelPolicyRef(raw: string): boolean {
  const parsed = parseModelCatalogRef(raw);
  return Boolean(
    parsed &&
    hasValidSegments([parsed.provider, ...parsed.modelId.split("/")], {
      min: 2,
    }),
  );
}

/** Share policy grammar and owner-scoped aliases between validation and migration. */
export function createModelPolicyRefValidator(
  defaultModels: Record<string, { alias?: string; aliases?: string[] }> | undefined,
  agentModels?: Record<string, { alias?: string; aliases?: string[] }>,
  options: { defaultProvider?: string } = {},
): (raw: string) => boolean {
  const aliasesByModel = new Map<string, string[]>();
  const defaultProvider = options.defaultProvider ?? DEFAULT_PROVIDER;
  for (const models of [defaultModels, agentModels]) {
    for (const [key, entry] of Object.entries(models ?? {})) {
      if (
        !entry ||
        typeof entry !== "object" ||
        parseModelPolicyWildcardRef(key) ||
        (!Object.hasOwn(entry, "alias") && !Object.hasOwn(entry, "aliases"))
      ) {
        continue;
      }
      const trimmedKey = key.trim();
      const normalizedKey = normalizeAgentModelRefForConfig(
        trimmedKey.includes("/") ? trimmedKey : `${defaultProvider}/${trimmedKey}`,
      );
      const ref = parseModelCatalogRef(normalizedKey);
      aliasesByModel.set(
        ref ? `${normalizeProviderId(ref.provider)}/${ref.modelId}` : normalizedKey,
        getConfiguredModelAliases(entry),
      );
    }
  }
  const aliases = new Set([...aliasesByModel.values()].flat().map(normalizeLowercaseStringOrEmpty));
  return (raw) => {
    const trimmed = raw.trim();
    return Boolean(
      aliases.has(normalizeLowercaseStringOrEmpty(trimmed)) ||
      MODEL_POLICY_COMPAT_SELECTORS.has(normalizeLowercaseStringOrEmpty(trimmed)) ||
      isValidExactModelPolicyRef(trimmed) ||
      parseModelPolicyWildcardRef(trimmed),
    );
  };
}
