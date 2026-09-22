/** Recursively freezes the cloned values distributed by diagnostic event owners. */
export function deepFreezeDiagnosticValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeDiagnosticValue(item, seen);
    }
    return Object.freeze(value);
  }
  const values: unknown[] = Object.values(value);
  for (const nested of values) {
    deepFreezeDiagnosticValue(nested, seen);
  }
  return Object.freeze(value);
}
