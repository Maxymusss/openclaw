import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { handleInvoke } from "../../node-host/invoke.js";
import { NodeRegistry } from "../node-registry.js";
import { createInstalledAppLoopbackTransport } from "./installed-app-loopback.test-support.js";

vi.mock("../../node-host/invoke.js", () => ({ handleInvoke: vi.fn() }));

it("forwards the registry's cancellation to the exact node invocation before draining", async () => {
  const started = createDeferred<AbortSignal | undefined>();
  const release = createDeferred();
  vi.mocked(handleInvoke).mockImplementation(async (_frame, _client, _bins, _context, runtime) => {
    started.resolve(runtime?.signal);
    await release.promise;
  });
  const registry = new NodeRegistry();
  const transport = createInstalledAppLoopbackTransport(registry);
  registry.register(transport.node, { pairingIdentity: "pairing" });
  const controller = new AbortController();
  try {
    const invoking = registry.invoke({
      nodeId: "paired-node",
      command: "device.apps.launch",
      signal: controller.signal,
      onProgress: () => {},
      timeoutMs: 5000,
    });
    const nodeSignal = await started.promise;
    controller.abort();
    await expect(invoking).resolves.toMatchObject({ ok: false, error: { code: "ABORTED" } });
    expect(nodeSignal?.aborted).toBe(true);
  } finally {
    release.resolve();
    registry.unregister("node-connection");
    await transport.drain();
    vi.mocked(handleInvoke).mockReset();
  }
});
