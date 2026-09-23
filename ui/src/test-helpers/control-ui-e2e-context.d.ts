import "vitest";
import type { ControlUiBuildInfo } from "../build-info-types.ts";

export type ControlUiE2eBuildIdentity = Pick<ControlUiBuildInfo, "buildId" | "version">;

export type ControlUiE2ePrebuiltAssets = {
  root: string;
  buildInfo: ControlUiE2eBuildIdentity;
};

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2ePrebuiltAssets?: ControlUiE2ePrebuiltAssets;
  }
}
