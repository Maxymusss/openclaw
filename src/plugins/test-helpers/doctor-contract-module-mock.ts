import path from "node:path";
import { vi } from "vitest";
import type { PluginModuleLoaderFactory } from "../plugin-module-loader-cache.js";

const doctorContractModuleLoaderMock = vi.hoisted(() => vi.fn<PluginModuleLoaderFactory>());

// Script Doctor exports at binding; setup instances still own callback lifetime.
vi.mock("../plugin-instance-module-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugin-instance-module-loader.js")>();
  const { getCachedPluginModuleLoader } = await import("../plugin-module-loader-cache.js");
  return {
    ...actual,
    bindPluginInstanceModuleLoader: (
      params: Parameters<typeof actual.bindPluginInstanceModuleLoader>[0],
    ) => {
      if (
        !doctorContractModuleLoaderMock.getMockImplementation() ||
        !/^(?:doctor-)?contract-api\.[cm]?[jt]s$/.test(path.basename(params.source))
      ) {
        return actual.bindPluginInstanceModuleLoader(params);
      }
      params.instance.bindModuleLoader(
        getCachedPluginModuleLoader({
          modulePath: params.source,
          importerUrl: import.meta.url,
          createLoader: doctorContractModuleLoaderMock,
        }),
      );
    },
  };
});

export function getDoctorContractModuleLoaderMock() {
  return doctorContractModuleLoaderMock;
}
