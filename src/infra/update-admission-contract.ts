import { z } from "zod";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";
import { UPDATE_RUN_DIAGNOSTIC_LIMIT, UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";

export const UPDATE_ADMISSION_PROTOCOL = 1;
export const UPDATE_ADMISSION_CONTEXT_ENV = "OPENCLAW_UPDATE_ADMISSION_CONTEXT";

const authorityEnvKeys = new Set<string>([
  ...SUPERVISOR_HINT_ENV_VARS,
  "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META",
  "OPENCLAW_GATEWAY_SERVICE_PID",
  "OPENCLAW_COMPATIBILITY_HOST_VERSION",
]);

/** Admission may observe a live profile, but cannot inherit an update or service continuation. */
export function isUpdateAdmissionAuthorityEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    authorityEnvKeys.has(normalized) ||
    (normalized.startsWith("OPENCLAW_UPDATE_") && normalized !== UPDATE_ADMISSION_CONTEXT_ENV)
  );
}

const text = z.string().min(1);
const identifier = (maxBytes: number) =>
  text.refine((value) => Buffer.byteLength(value) <= maxBytes);
const reasonCode = identifier(80);
const version = identifier(128);
const channel = z.enum(["stable", "extended-stable", "beta", "dev"]);
const contextSchema = z.object({
  protocol: z.literal(UPDATE_ADMISSION_PROTOCOL),
  installation: z.object({
    root: text,
    canonicalRoot: text,
    version: text.nullable(),
    installKind: z.enum(["package", "git", "unknown"]),
    packageManager: z.enum(["npm", "pnpm", "bun"]),
    globalRoot: text.optional(),
  }),
  target: z.object({
    spec: text,
    version: text.nullable(),
    source: z.enum(["registry", "artifact"]),
    channel,
    tag: text.optional(),
  }),
  request: z.object({
    yes: z.boolean(),
    noRestart: z.boolean(),
    acceptCapabilities: z.boolean(),
    json: z.boolean(),
    timeoutMs: z.number().finite().positive().optional(),
    requestedChannel: channel.nullable().optional(),
  }),
  run: z.object({ id: text }),
  supervisor: z.object({ version: text, host: text, pid: z.number().int().positive() }),
});

export const UpdateAdmissionCheckSchema = z.object({
  name: identifier(128),
  status: z.enum(["ok", "warn", "refuse"]),
  detail: text.optional(),
});

export const UpdateAdmissionVerdictSchema = z
  .object({
    protocol: z.literal(UPDATE_ADMISSION_PROTOCOL),
    verdict: z.enum(["admit", "refuse"]),
    reasons: z
      .array(z.object({ code: reasonCode, message: text, nextAction: text.optional() }))
      .max(UPDATE_RUN_DIAGNOSTIC_LIMIT),
    warnings: z.array(z.object({ code: text, message: text })),
    facts: z.object({
      candidateVersion: version,
      installedVersion: version.nullable(),
      checks: z.array(UpdateAdmissionCheckSchema).max(UPDATE_RUN_DIAGNOSTIC_LIMIT),
    }),
  })
  .refine(
    (value) =>
      new Set(value.facts.checks.map((check) => check.name)).size === value.facts.checks.length,
  )
  .refine((value) =>
    value.verdict === "refuse"
      ? value.reasons.length > 0
      : value.reasons.length === 0 &&
        value.facts.checks.every((check) => check.status !== "refuse"),
  )
  .refine((value) => {
    const checks = value.facts.checks.map((check) => ({
      ...check,
      ...(check.detail !== undefined ? { detail: "" } : {}),
    }));
    const identity = {
      admission: {
        owner: "candidate",
        protocol: value.protocol,
        candidateVersion: value.facts.candidateVersion,
        checks,
      },
      candidateAdmission: {
        ...value,
        reasons: value.reasons.map((reason) => ({
          ...reason,
          message: "",
          ...(reason.nextAction !== undefined ? { nextAction: "" } : {}),
        })),
        warnings: [],
        facts: { ...value.facts, checks },
      },
    };
    // Leave room in origin's 16 KiB for eight maximally escaped driver
    // identities and the remaining origin field names, even after all prose shrinks.
    return Buffer.byteLength(JSON.stringify(identity)) <= 2 * UPDATE_RUN_TEXT_LIMIT;
  });

export type UpdateAdmissionContext = z.infer<typeof contextSchema>;
export type UpdateAdmissionVerdict = z.infer<typeof UpdateAdmissionVerdictSchema>;

/** Admission carries observations only, never update execution authority. */
export function parseUpdateAdmissionContext(value: unknown): UpdateAdmissionContext | null {
  const parsed = contextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseUpdateAdmissionVerdict(value: unknown): UpdateAdmissionVerdict | null {
  const parsed = UpdateAdmissionVerdictSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const verdict = parsed.data;
  return {
    ...verdict,
    // Warnings cannot invalidate a decision or spend authoritative receipt capacity.
    warnings: verdict.warnings
      .filter((warning) => reasonCode.safeParse(warning.code).success)
      .slice(0, UPDATE_RUN_DIAGNOSTIC_LIMIT),
  };
}
