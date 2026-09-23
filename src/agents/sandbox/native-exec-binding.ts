import type { SandboxBackendHandle } from "./backend.types.js";
import type { NativeSandboxCustody } from "./container-engine.js";

type NativeExecution = Readonly<
  Pick<NativeSandboxCustody, "runtimeKey" | "signal" | "assertCurrent">
>;
const bindings = new WeakMap<object, NativeExecution>();
const replacements = new WeakMap<
  SandboxBackendHandle,
  (custody: NativeSandboxCustody) => Promise<SandboxBackendHandle>
>();

/** Only the private builtin producer issues this fact; an SDK handle/id cannot claim it. */
export function registerNativeSandboxExecution(
  handle: SandboxBackendHandle,
  custody: NativeSandboxCustody,
  replace: (custody: NativeSandboxCustody) => Promise<SandboxBackendHandle>,
) {
  custody.assertCurrent();
  bindings.set(
    handle,
    Object.freeze({
      runtimeKey: custody.runtimeKey,
      signal: custody.signal,
      assertCurrent: custody.assertCurrent,
    }),
  );
  replacements.set(handle, replace);
}

export function replaceNativeSandboxBackendFromHandle(
  handle: SandboxBackendHandle,
  custody: NativeSandboxCustody,
) {
  const replace = replacements.get(handle);
  if (!replace) {
    throw new Error("Sandbox replacement requires the original native generation handle.");
  }
  return replace(custody);
}

/** Carry the same generation through the existing exec projection without public trust flags. */
export function bindNativeSandboxExecTarget<T extends object>(
  target: T,
  backend?: SandboxBackendHandle,
): T {
  const binding = backend && bindings.get(backend);
  if (binding) {
    binding.assertCurrent();
    bindings.set(target, binding);
  }
  return target;
}

export function readNativeSandboxExecTarget(target: object | undefined, scopeKey?: string) {
  const binding = target && bindings.get(target);
  if (!binding) {
    return undefined;
  }
  binding.assertCurrent();
  binding.signal.throwIfAborted();
  if (binding.runtimeKey !== scopeKey) {
    throw new Error("Native sandbox exec belongs to a different tool generation.");
  }
  return binding;
}
