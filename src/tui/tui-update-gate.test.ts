import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runTuiAfterUpdateGate } from "./tui-update-gate.js";

describe("TUI update startup gate", () => {
  const originalTitle = process.title;
  afterEach(() => {
    process.title = originalTitle;
  });

  it("does not load the mutable TUI graph until an in-flight update finishes", async () => {
    const waiting = createDeferred();
    const runTui = vi.fn();
    const load = vi.fn(async () => ({ runTui }) as never);

    const loading = runTuiAfterUpdateGate({} as never, {
      resolveRoot: () => "/opt/openclaw",
      wait: async () => await waiting.promise,
      load,
    });

    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    waiting.resolve();
    await loading;
    expect(load).toHaveBeenCalledOnce();
    expect(runTui).toHaveBeenCalledOnce();
  });
});
