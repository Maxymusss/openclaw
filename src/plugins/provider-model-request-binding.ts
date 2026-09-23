import type { ModelRequestBindingLeafSupport } from "@openclaw/ai";
import type { ProviderPlugin } from "./provider-plugin.types.js";
import type {
  ProviderModelRequestBindingContext,
  ProviderModelRequestBindingResult,
} from "./provider-transport.types.js";

type BindingHook = keyof ProviderModelRequestBindingResult;
type BindingContext = ProviderModelRequestBindingContext & { plugin?: ProviderPlugin };

/** Pure queries receive a copied physical route, never runtime headers or credentials. */
export function readProviderModelRequestBindingDeclaration(params: BindingContext) {
  const { provider, id, api, baseUrl } = params.model;
  return params.plugin?.resolveModelRequestBindingSupport?.(
    Object.freeze({
      model: Object.freeze({ provider, id, api, baseUrl }),
      transport: params.transport,
    }),
  );
}

export function providerModelRequestBindingHookSupported(
  params: BindingContext & { hook: BindingHook },
  declaration: ProviderModelRequestBindingResult | undefined,
): boolean {
  if (!params.plugin?.[params.hook]) {
    return true;
  }
  return (
    params.transport !== undefined &&
    declaration?.[params.hook] ===
      (params.hook === "createStreamFn" ? "wire-model-v1" : "preserves-delegate")
  );
}

/** Construction and catalog projection use this same route/leaf/wrapper truth table. */
export function providerModelRequestBindingSupported(
  params: BindingContext & {
    leaf?: ModelRequestBindingLeafSupport;
    wrapper?: "wrapStreamFn" | "wrapSimpleCompletionStreamFn";
  },
): boolean {
  const declaration = readProviderModelRequestBindingDeclaration(params);
  const base = params.plugin?.createStreamFn
    ? providerModelRequestBindingHookSupported({ ...params, hook: "createStreamFn" }, declaration)
    : params.transport !== undefined &&
      params.leaf?.contract === "wire-model-v1" &&
      params.leaf.transports.includes(params.transport);
  return (
    base &&
    (!params.wrapper ||
      providerModelRequestBindingHookSupported({ ...params, hook: params.wrapper }, declaration))
  );
}

/** Registry facts describe the physical delegate, not the first caller's selected transport. */
export function readProviderModelRequestBindingSupport(
  params: Omit<Parameters<typeof providerModelRequestBindingSupported>[0], "transport">,
): ModelRequestBindingLeafSupport | undefined {
  const candidates = params.plugin?.createStreamFn
    ? (["sse", "websocket", "websocket-cached", "auto"] as const)
    : (params.leaf?.transports ?? []);
  const transports = candidates.filter((transport) =>
    providerModelRequestBindingSupported({ ...params, transport }),
  );
  return transports.length ? { contract: "wire-model-v1", transports } : undefined;
}
