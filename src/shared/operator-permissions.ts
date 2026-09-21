import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";

/** Additional restrictions on an operator grant; absent dimensions impose no ceiling. */
export type OperatorPermissionCeiling = Readonly<{
  models?: Readonly<{ allow: readonly string[] }>;
}>;

export function operatorModelAllowed(
  permissions: OperatorPermissionCeiling | undefined,
  provider: string,
  model: string,
): boolean {
  return permissions?.models?.allow.includes(buildModelCatalogRef(provider, model)) ?? true;
}

export function freezeOperatorPermissionCeiling(
  permissions: OperatorPermissionCeiling | undefined,
): OperatorPermissionCeiling | undefined {
  if (permissions === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(permissions.models
      ? { models: Object.freeze({ allow: Object.freeze([...new Set(permissions.models.allow)]) }) }
      : {}),
  });
}

/** Removing or widening a current restriction cannot widen the original admission. */
export function intersectOperatorPermissionCeilings(
  original: OperatorPermissionCeiling | undefined,
  current: OperatorPermissionCeiling | undefined,
): OperatorPermissionCeiling | undefined {
  const originalModels = original?.models?.allow;
  const currentModels = current?.models?.allow;
  if (originalModels === undefined) {
    return freezeOperatorPermissionCeiling(current);
  }
  return freezeOperatorPermissionCeiling({
    models: {
      allow:
        currentModels === undefined
          ? originalModels
          : originalModels.filter((ref) => currentModels.includes(ref)),
    },
  });
}
