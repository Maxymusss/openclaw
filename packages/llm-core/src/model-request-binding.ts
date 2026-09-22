/**
 * Promises per-request canonical-to-wire model binding and authority revalidation
 * at final dispatch, including retries. The marker grants no authority itself;
 * transparent wrappers must always call a qualified delegate and own no egress.
 */
export interface ModelRequestBindingSupport {
  readonly modelRequestBinding?: "wire-model-v1";
}

/** Only transparent adapters may carry their delegate's qualification forward. */
export function inheritModelRequestBinding<T extends object>(
  adapter: T,
  delegate: ModelRequestBindingSupport,
): T & ModelRequestBindingSupport {
  return Object.assign(adapter, { modelRequestBinding: delegate.modelRequestBinding });
}
