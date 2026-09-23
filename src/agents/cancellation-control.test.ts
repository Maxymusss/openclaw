import { describe, expect, it } from "vitest";
import { captureCancellationControl, withCancellationControl } from "./cancellation-control.js";

describe("native cancellation custody", () => {
  it("composes nested caller authority and revokes retained callbacks after scope exit", async () => {
    let parentCurrent = true;
    let childCurrent = true;
    let retained: ReturnType<typeof captureCancellationControl>;
    await withCancellationControl(
      {
        assertCurrent() {
          if (!parentCurrent) {
            throw new Error("parent retired");
          }
        },
      },
      async () => {
        await withCancellationControl(
          {
            assertCurrent() {
              if (!childCurrent) {
                throw new Error("child retired");
              }
            },
          },
          async () => {
            retained = captureCancellationControl();
            retained?.assertCurrent();
            parentCurrent = false;
            expect(() => retained?.assertCurrent()).toThrow("parent retired");
            parentCurrent = true;
            childCurrent = false;
            expect(() => retained?.assertCurrent()).toThrow("child retired");
            childCurrent = true;
          },
        );
        expect(() => retained?.assertCurrent()).toThrow("no longer authorized");
      },
    );
    expect(captureCancellationControl()).toBeUndefined();
  });
});
