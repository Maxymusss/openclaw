import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertSecretOwnerAvailable,
  isTrustedSecretSurfaceUnavailableError,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import * as transport from "./github-api.js";

export type { ControlUiGitHubError } from "./github-api.js";

export const CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE =
  "The configured Control UI GitHub credential is unavailable. Resolve gateway.controlUi.github.token and retry.";

/** Host credential selection uses canonical config and degradation state. */
export function githubApiToken(
  env: NodeJS.ProcessEnv = process.env,
  config: OpenClawConfig | null = getRuntimeConfigSnapshot(),
): string | undefined {
  const configured = config?.gateway?.controlUi?.github?.token;
  if (configured !== undefined) {
    assertSecretOwnerAvailable("capability", "control-ui-github");
    const token = typeof configured === "string" ? configured.trim() : "";
    if (!token) {
      throw new SecretSurfaceUnavailableError({
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        paths: ["gateway.controlUi.github.token"],
        refKeys: [],
        reason: "secret reference was not materialized by the active runtime",
      });
    }
    return token;
  }
  return env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined;
}

export function hasConfiguredGitHubApiCredential(
  env: NodeJS.ProcessEnv,
  config: OpenClawConfig,
): boolean {
  return (
    config.gateway?.controlUi?.github?.token !== undefined ||
    Boolean(env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim())
  );
}

/** Core GitHub transport for project search, repository admission, identity and PR status. */
export const gitHubPublicApi = {
  ...transport,
  resolveGitHubApiCredentialScope(env: NodeJS.ProcessEnv = process.env) {
    const token = githubApiToken(env);
    return { token, cacheScope: transport.githubApiCredentialCacheScope(token) };
  },
  // Existing host callers use this formatter for project search and CI details,
  // not link previews. Keep their call contract without loading a reader plugin.
  formatControlUiGitHubPreviewError(
    error: unknown,
  ): ReturnType<typeof transport.formatGitHubApiError> {
    return isTrustedSecretSurfaceUnavailableError(error)
      ? { message: CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE, retryable: false }
      : transport.formatGitHubApiError(error);
  },
};
