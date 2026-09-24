import { describe, expect, it } from "vitest";
import { requestCodexAppServerClientJson } from "./request.js";
import { createClientHarness } from "./test-support.js";

describe("requestCodexAppServerClientJson authority", () => {
  it.each([false, true])(
    "classifies async authority rejection without inventing a prewrite outcome (written: %s)",
    async (written) => {
      const harness = createClientHarness();
      const failure = new Error("lineage guard unavailable");
      try {
        const request = requestCodexAppServerClientJson({
          client: harness.client,
          method: "thread/list",
          requestParams: {},
          withCurrent: async (write) => {
            if (written) {
              write();
            }
            throw failure;
          },
        });
        if (written) {
          await expect(request).rejects.toMatchObject({
            name: "CodexAppServerIndeterminateTransportError",
            code: "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE",
            mayHaveWritten: true,
            cause: failure,
          });
        } else {
          await expect(request).rejects.toMatchObject({
            name: "CodexAppServerScopedRequestRejectedError",
            cause: failure,
          });
        }
        expect(harness.writes).toHaveLength(written ? 1 : 0);
      } finally {
        harness.client.close();
      }
    },
  );
});
