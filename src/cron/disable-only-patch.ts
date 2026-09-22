/** Disabling a job is settlement; combining it with new work still needs execution authority. */
export function isCronDisableOnlyPatch(patch: object & { enabled?: unknown }): boolean {
  return (
    patch.enabled === false &&
    Object.entries(patch).every(([key, value]) => key === "enabled" || value === undefined)
  );
}
