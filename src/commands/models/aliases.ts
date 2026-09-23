/** Commands for listing, adding, and removing model aliases. */
import { formatCliCommand } from "../../cli/command-format.js";
import { DEFAULT_MODEL_ALIASES } from "../../config/defaults.js";
import { logConfigUpdated } from "../../config/logging.js";
import { getConfiguredModelAliases } from "../../config/model-aliases.js";
import { normalizeAgentModelMapForConfig } from "../../config/model-input.js";
import { type RuntimeEnv, writeRuntimeJson, writeRuntimeStdout } from "../../runtime.js";
import { normalizeAlias } from "./alias-name.js";
import { loadModelsConfig } from "./load-config.js";
import {
  ensureFlagCompatibility,
  resolveModelTarget,
  upsertCanonicalModelConfigEntry,
  updateConfig,
} from "./shared.js";

/** Lists configured model aliases as JSON, plain pairs, or human-readable rows. */
export async function modelsAliasesListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = await loadModelsConfig({ commandName: "models aliases list", runtime });
  const models = cfg.agents?.defaults?.models ?? {};
  const aliases = Object.fromEntries(
    Object.entries(models).flatMap(([modelKey, entry]) =>
      getConfiguredModelAliases(entry).map((alias) => [alias, modelKey] as const),
    ),
  );
  const aliasEntries = Object.entries(aliases).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );

  if (opts.json) {
    writeRuntimeJson(runtime, { aliases: Object.fromEntries(aliasEntries) });
    return;
  }
  if (opts.plain) {
    for (const [alias, target] of aliasEntries) {
      writeRuntimeStdout(runtime, `${alias} ${target}`);
    }
    return;
  }

  runtime.log(`Aliases (${aliasEntries.length}):`);
  if (aliasEntries.length === 0) {
    runtime.log("- none");
    return;
  }
  for (const [alias, target] of aliasEntries) {
    runtime.log(`- ${alias} -> ${target}`);
  }
}

/** Adds an alias or updates its spelling without replacing the model's other names. */
export async function modelsAliasesAddCommand(
  aliasRaw: string,
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const alias = normalizeAlias(aliasRaw);
  const normalizedAlias = alias.toLowerCase();
  let target = modelRaw;
  await updateConfig(
    (cfgLocal, context) => {
      // Alias resolution must share the snapshot whose hash fences this write.
      const resolved = resolveModelTarget({ raw: modelRaw, cfg: context.runtimeConfig });
      // Compare resolved names before restoring authored environment references on a key move.
      const resolvedModels = { ...cfgLocal.agents?.defaults?.models };
      const modelKey = upsertCanonicalModelConfigEntry(resolvedModels, resolved, {
        canonicalModelKeys: context.canonicalModelKeys,
      });
      let resolvedEntry = resolvedModels[modelKey];
      const nextModels = { ...cfgLocal.agents?.defaults?.models };
      upsertCanonicalModelConfigEntry(nextModels, resolved, context);
      target = modelKey;
      // Model selection folds alias case, so case variants must not collide.
      for (const [key, entry] of Object.entries(nextModels)) {
        if (
          key !== modelKey &&
          getConfiguredModelAliases(entry).some(
            (existing) => existing.toLowerCase() === normalizedAlias,
          )
        ) {
          throw new Error(`Alias ${alias} already points to ${key}.`);
        }
      }
      let entry = nextModels[modelKey];
      let existing = getConfiguredModelAliases(resolvedEntry);
      if (existing.length === 0) {
        const [runtimeAlias, ...runtimeAliases] = getConfiguredModelAliases(
          context.runtimeConfig.agents?.defaults?.models?.[modelKey],
        );
        if (runtimeAlias) {
          // Adding a name also preserves the target's previously materialized built-in name.
          entry = {
            ...entry,
            alias: runtimeAlias,
            ...(runtimeAliases.length ? { aliases: runtimeAliases } : {}),
          };
          resolvedEntry = entry;
          existing = getConfiguredModelAliases(entry);
        }
      }
      if (existing.length === 0) {
        nextModels[modelKey] = { ...entry, alias };
      } else if (resolvedEntry?.alias?.trim().toLowerCase() === normalizedAlias) {
        nextModels[modelKey] = {
          ...entry,
          alias: resolvedEntry.alias === alias ? entry?.alias : alias,
        };
      } else {
        const aliases = entry?.aliases ?? [];
        const resolvedAliases = resolvedEntry?.aliases ?? [];
        nextModels[modelKey] = {
          ...entry,
          aliases: resolvedAliases.some((name) => name.trim().toLowerCase() === normalizedAlias)
            ? aliases.map((name, index) => {
                const resolvedName = resolvedAliases[index];
                return resolvedName?.trim().toLowerCase() === normalizedAlias &&
                  resolvedName !== alias
                  ? alias
                  : name;
              })
            : [...aliases, alias],
        };
      }
      return {
        ...cfgLocal,
        agents: {
          ...cfgLocal.agents,
          defaults: {
            ...cfgLocal.agents?.defaults,
            models: nextModels,
          },
        },
      };
    },
    (_cfg, context) => [resolveModelTarget({ raw: modelRaw, cfg: context.runtimeConfig })],
  );

  logConfigUpdated(runtime);
  runtime.log(`Alias ${alias} -> ${target}`);
}

/** Removes a configured alias by name. */
export async function modelsAliasesRemoveCommand(aliasRaw: string, runtime: RuntimeEnv) {
  const alias = normalizeAlias(aliasRaw);
  const normalizedAlias = alias.toLowerCase();
  const updated = await updateConfig((cfg) => {
    const nextModels = { ...cfg.agents?.defaults?.models };
    let found = false;
    for (const [key, entry] of Object.entries(nextModels)) {
      const aliases = entry?.aliases?.filter(
        (name) => name.trim().toLowerCase() !== normalizedAlias,
      );
      const removePrimary = entry?.alias?.trim().toLowerCase() === normalizedAlias;
      if (removePrimary || aliases?.length !== entry?.aliases?.length) {
        nextModels[key] = {
          ...entry,
          ...(removePrimary ? { alias: undefined } : {}),
          ...(aliases ? { aliases } : {}),
        };
        found = true;
      }
    }
    if (!found) {
      // A built-in alias is materialized into the resolved config by applyModelDefaults
      // when (a) the alias name is in DEFAULT_MODEL_ALIASES and (b) the target model
      // entry exists in the user's source config without an explicit alias set. In that
      // case the user sees the alias in `models aliases list` but it cannot be removed
      // because it isn't actually stored in the config file.
      //
      // applyModelDefaults materializes those aliases against the *normalized* model map
      // (provider ids and retired Google preview keys are canonicalized first), so an
      // entry whose only matching key is un-normalized still surfaces the alias in `list`.
      // Match that contract here so `remove` recognizes the same built-in aliases.
      const builtinTarget = DEFAULT_MODEL_ALIASES[normalizedAlias];
      const normalizedModels = normalizeAgentModelMapForConfig(nextModels);
      if (
        builtinTarget &&
        normalizedModels[builtinTarget] &&
        normalizedModels[builtinTarget]?.alias === undefined &&
        !normalizedModels[builtinTarget]?.aliases?.length
      ) {
        throw new Error(
          `Cannot remove "${alias}": it is a built-in alias for "${builtinTarget}" provided automatically by OpenClaw and is not stored in your config file. To shadow it with a different target, run ${formatCliCommand(`openclaw models aliases add ${alias} <model>`)}.`,
        );
      }
      throw new Error(
        `Alias not found: ${alias}. Run ${formatCliCommand("openclaw models aliases list")} to see configured aliases.`,
      );
    }
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models: nextModels,
        },
      },
    };
  });

  logConfigUpdated(runtime);
  if (
    !updated.agents?.defaults?.models ||
    Object.values(updated.agents.defaults.models).every(
      (entry) => getConfiguredModelAliases(entry).length === 0,
    )
  ) {
    runtime.log("No aliases configured.");
  }
}
