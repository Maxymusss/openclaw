import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type CancellationControl = {
  assertCurrent: () => void;
  prepareRead?: () => Promise<void> | undefined;
};
const controls = resolveGlobalSingleton(
  Symbol.for("openclaw.executionCancellationControl"),
  () => new AsyncLocalStorage<CancellationControl>(),
);
/** Preserve live caller authority through runtime handoffs; never outlive the admitted cancellation. */
export async function withCancellationControl<T>(
  control: CancellationControl | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!control) {
    return operation();
  }
  const inherited = controls.getStore();
  let active = true;
  const assertActive = () => {
    if (!active) {
      throw new Error("Cancellation is no longer authorized.");
    }
  };
  const scoped: CancellationControl = {
    assertCurrent: () => {
      assertActive();
      inherited?.assertCurrent();
      control.assertCurrent();
    },
    prepareRead: () => {
      assertActive();
      return inherited?.prepareRead?.() ?? control.prepareRead?.();
    },
  };
  try {
    return await controls.run(scoped, operation);
  } finally {
    active = false;
  }
}
export function captureCancellationControl(): CancellationControl | undefined {
  return controls.getStore();
}
