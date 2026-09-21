import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { createFailureMessage } from "./turn-interruption.js";

const model: Model = {
  provider: "fixture",
  id: "selected",
  name: "Selected",
  api: "fixture",
  baseUrl: "https://provider.example/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 1024,
  maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("agent failure message identity", () => {
  it.each(["PERMANENT_PROVIDER_DENIAL", 403])("preserves structured code %s", (code) => {
    const error = Object.assign(new Error("Provider refused the request"), { code });
    expect(createFailureMessage(model, error, false)).toMatchObject({
      stopReason: "error",
      errorMessage: "Provider refused the request",
      errorCode: String(code),
      provider: "fixture",
      model: "selected",
      content: [{ type: "text", text: "" }],
    });
  });

  it.each([false, true])(
    "preserves ordinary failure and abort semantics (aborted=%s)",
    (aborted) => {
      const result = createFailureMessage(model, new Error("request ended"), aborted);
      expect(result).toMatchObject({
        stopReason: aborted ? "aborted" : "error",
        errorMessage: "request ended",
        usage: { totalTokens: 0 },
      });
      expect(result).not.toHaveProperty("errorCode");
    },
  );
});
