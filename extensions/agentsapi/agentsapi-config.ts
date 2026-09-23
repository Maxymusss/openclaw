import { buildOptionalSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

export const AgentsApiConfigSchema = z
  .object({
    apiKey: buildOptionalSecretInputSchema(),
  })
  .strict();

export type AgentsApiConfig = z.infer<typeof AgentsApiConfigSchema>;
