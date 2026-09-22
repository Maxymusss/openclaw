import type { ContextEngine } from "../../context-engine/types.js";

export function createBackgroundMaintenanceEngine(
  maintain: NonNullable<ContextEngine["maintain"]>,
  id = "test",
): ContextEngine {
  return {
    info: { id, name: "Test Engine", turnMaintenanceMode: "background" },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    maintain,
  };
}
