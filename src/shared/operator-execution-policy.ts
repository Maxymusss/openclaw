/** A restriction on accepted work, never permission to start a run. */
export type OperatorExecutionPolicy = "foreground-only";

/** Plugin values cross a runtime boundary even when their TypeScript caller is typed. */
export function readOperatorExecutionPolicy(value: unknown): OperatorExecutionPolicy | undefined {
  if (value === undefined || value === "foreground-only") {
    return value;
  }
  throw new TypeError("Unsupported operator execution policy");
}
