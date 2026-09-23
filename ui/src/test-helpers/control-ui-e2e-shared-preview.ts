import type { ControlUiE2eBuildIdentity } from "./control-ui-e2e-context.js";

let sharedPreview: {
  baseUrl: string;
  buildInfo: ControlUiE2eBuildIdentity | null;
} | null = null;

export function getSharedControlUiE2ePreview() {
  return sharedPreview;
}

export function setSharedControlUiE2eServerBaseUrl(
  baseUrl: string | null,
  buildInfo?: ControlUiE2eBuildIdentity | null,
): void {
  sharedPreview = baseUrl ? { baseUrl, buildInfo: buildInfo ?? null } : null;
}
