import { describe, expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionModelAuthorityError } from "./session-model-authority.js";

const cfg: OpenClawConfig = { agents: { defaults: { model: "fixture/hidden" } } };
const entry: InternalSessionEntry = { sessionId: "own-session", updatedAt: 1 };
const supported: AgentHarness = {
  id: "fixture-runtime",
  label: "Fixture runtime",
  operatorModelPolicySupport: "exact",
  supports: () => ({ supported: true }),
  async runAttempt() {
    throw new Error("Selection must not execute a turn");
  },
};

function source(allow: string[]) {
  let current = true;
  return {
    close: () => {
      current = false;
    },
    authority: createAdmittedRunOperatorAuthority({
      profileId: "selection-owner",
      scopes: ["operator.sessions.write"],
      permissions: { models: { allow } },
      assertCurrent: () => {
        if (!current) {
          throw new Error("original selection source revoked");
        }
      },
    }),
  };
}

describe("session model selection authority", () => {
  it("denies a hidden inherited default and accepts the explicit allowed tuple", () => {
    const original = source(["fixture/allowed"]);
    const params = { cfg, agentId: "main", entry, operatorAuthority: original.authority };
    expect(resolveSessionModelAuthorityError(params)).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("does not allow this model"),
    });
    expect(
      resolveSessionModelAuthorityError({
        ...params,
        entry: {
          ...entry,
          providerOverride: "fixture",
          modelOverride: "allowed",
          agentRuntimeOverride: supported.id,
        },
        preparedRuntime: { harness: supported },
      }),
    ).toBeUndefined();
  });

  it("rechecks source, final selection and runtime support at the later commit", () => {
    const original = source(["fixture/allowed"]);
    const selected = {
      ...entry,
      providerOverride: "fixture",
      modelOverride: "allowed",
      agentRuntimeOverride: supported.id,
    };
    const params = {
      cfg,
      agentId: "main",
      entry: selected,
      operatorAuthority: original.authority,
      preparedRuntime: { harness: supported },
    };
    expect(resolveSessionModelAuthorityError(params)).toBeUndefined();
    selected.modelOverride = "hidden";
    expect(resolveSessionModelAuthorityError(params)).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("does not allow this model"),
    });
    selected.modelOverride = "allowed";
    expect(
      resolveSessionModelAuthorityError({
        ...params,
        preparedRuntime: { harness: { ...supported, operatorModelPolicySupport: undefined } },
      }),
    ).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("cannot enforce") });
    original.close();
    expect(resolveSessionModelAuthorityError(params)).toMatchObject({
      code: "FORBIDDEN",
      message: "original selection source revoked",
    });
  });

  it("keeps omitted ceilings and internal selection behavior unchanged", () => {
    expect(
      resolveSessionModelAuthorityError({ cfg, agentId: "main", entry, preparedRuntime: {} }),
    ).toBeUndefined();
    const unrestricted = createAdmittedRunOperatorAuthority({
      profileId: "maintainer",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    expect(
      resolveSessionModelAuthorityError({
        cfg,
        agentId: "main",
        entry,
        operatorAuthority: unrestricted,
        preparedRuntime: { harness: { ...supported, operatorModelPolicySupport: undefined } },
      }),
    ).toBeUndefined();
  });
});
