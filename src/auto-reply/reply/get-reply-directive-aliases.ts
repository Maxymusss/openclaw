// Exposes reply directive aliases for parsing and command help.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ModelAliasIndex } from "../../agents/model-selection-shared.js";
import type { SkillCommandSpec } from "../../skills/types.js";

export function reserveSkillCommandNames(params: {
  reservedCommands: Set<string>;
  skillCommands: SkillCommandSpec[];
}) {
  for (const command of params.skillCommands) {
    params.reservedCommands.add(normalizeLowercaseStringOrEmpty(command.name));
  }
}

export function resolveConfiguredDirectiveAliases(params: {
  aliasIndex: ModelAliasIndex;
  commandTextHasSlash: boolean;
  reservedCommands: Set<string>;
}) {
  if (!params.commandTextHasSlash) {
    return [];
  }
  return [...params.aliasIndex.byAlias.values()]
    .map(({ alias }) => alias)
    .filter((alias) => !params.reservedCommands.has(normalizeLowercaseStringOrEmpty(alias)));
}
