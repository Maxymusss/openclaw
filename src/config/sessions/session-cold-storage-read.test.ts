import { beforeEach, describe, expect, it, vi } from "vitest";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { restoreSessionColdTranscript } from "./session-cold-storage.js";

vi.mock("./session-cold-storage.js", () => ({
  restoreSessionColdTranscript: vi.fn(async () => {}),
}));

const scope = { agentId: "main", sessionId: "retained-transcript" };

beforeEach(() => vi.clearAllMocks());

describe("readRestoredSessionTranscript", () => {
  it("lets a worker's hot snapshot finish without a host restoration lookup", async () => {
    const read = vi.fn(async () => "hot message");
    await expect(
      readRestoredSessionTranscript(scope, read, { restoreBeforeRead: false }),
    ).resolves.toBe("hot message");
    expect(read).toHaveBeenCalledOnce();
    expect(restoreSessionColdTranscript).not.toHaveBeenCalled();
  });

  it("restores only after the worker reports this transcript cold, with the retained guard", async () => {
    const assertCurrent = vi.fn();
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new SessionTranscriptColdError(scope.sessionId))
      .mockResolvedValueOnce("restored message");
    await expect(
      readRestoredSessionTranscript(scope, read, { restoreBeforeRead: false, assertCurrent }),
    ).resolves.toBe("restored message");
    expect(restoreSessionColdTranscript).toHaveBeenCalledExactlyOnceWith(scope, assertCurrent);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not restore another transcript or retry its failed worker read", async () => {
    const failure = new SessionTranscriptColdError("different-transcript");
    const read = vi.fn(async () => {
      throw failure;
    });
    await expect(
      readRestoredSessionTranscript(scope, read, { restoreBeforeRead: false }),
    ).rejects.toBe(failure);
    expect(restoreSessionColdTranscript).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([false, true])("restores a cold read once (async=%s)", async (asynchronous) => {
    const cold = new SessionTranscriptColdError(scope.sessionId);
    const read = vi
      .fn<() => string | Promise<string>>()
      .mockImplementationOnce(() => {
        if (asynchronous) {
          return Promise.reject(cold);
        }
        throw cold;
      })
      .mockReturnValue("retained text");

    await expect(readRestoredSessionTranscript(scope, read)).resolves.toBe("retained text");
    expect(read).toHaveBeenCalledTimes(2);
    expect(restoreSessionColdTranscript).toHaveBeenCalledTimes(2);
    expect(restoreSessionColdTranscript).toHaveBeenNthCalledWith(1, scope, undefined);
    expect(restoreSessionColdTranscript).toHaveBeenNthCalledWith(2, scope, undefined);
  });

  it.each([new Error("read unavailable"), new SessionTranscriptColdError("another-transcript")])(
    "propagates an unrelated asynchronous read failure: %s",
    async (failure) => {
      const read = vi.fn(async () => {
        throw failure;
      });

      await expect(readRestoredSessionTranscript(scope, read)).rejects.toBe(failure);
      expect(read).toHaveBeenCalledOnce();
      expect(restoreSessionColdTranscript).toHaveBeenCalledExactlyOnceWith(scope, undefined);
    },
  );

  it("propagates a second cold rejection without repeating restoration", async () => {
    const cold = new SessionTranscriptColdError(scope.sessionId);
    const read = vi.fn(async () => {
      throw cold;
    });

    await expect(readRestoredSessionTranscript(scope, read)).rejects.toBe(cold);
    expect(read).toHaveBeenCalledTimes(2);
    expect(restoreSessionColdTranscript).toHaveBeenCalledTimes(2);
  });
});
