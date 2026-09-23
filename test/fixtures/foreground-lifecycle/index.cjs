const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const provider = "foreground-lifecycle";

module.exports = {
  id: provider,
  register(api) {
    const origin = new URL(api.pluginConfig.origin).origin;
    if (new URL(origin).hostname !== "127.0.0.1") throw new Error("Fixture requires loopback");
    const baseUrl = `${origin}/v1`;
    const grants = new Map();
    const children = new Set();
    const eligible = ({ model, transport }) =>
      model.provider === provider &&
      model.api === "openai-responses" &&
      model.baseUrl === baseUrl &&
      transport === "sse";
    api.registerGatewayAccessPolicy({
      authorize({ profile, requiredByRole, supportedExecutionPolicies }) {
        if (!requiredByRole) return undefined;
        if (!supportedExecutionPolicies?.includes("foreground-only")) {
          throw new Error("This candidate does not advertise foreground enforcement");
        }
        let grant = grants.get(profile.profileId);
        if (!grant) {
          grant = { id: randomUUID(), abort: new AbortController() };
          grants.set(profile.profileId, grant);
        }
        return {
          grantId: grant.id,
          executionPolicy: "foreground-only",
          signal: grant.abort.signal,
          assertCurrent: () => grant.abort.signal.throwIfAborted(),
        };
      },
    });
    api.registerProvider({
      id: provider,
      label: "Foreground lifecycle fixture",
      auth: [],
      resolveModelRequestBindingSupport(context) {
        return eligible(context) ? { wrapStreamFn: "preserves-delegate" } : undefined;
      },
      wrapStreamFn({ streamFn }) {
        if (!streamFn) throw new Error("Fixture requires the actual supplied transport");
        const wrapped = (model, context, options) =>
          streamFn(model, context, {
            ...options,
            async onResponse(response, responseModel) {
              await options?.onResponse?.(response, responseModel);
              options?.signal?.throwIfAborted();
              const id = response.headers["x-fixture-turn"];
              const mode = response.headers["x-fixture-cleanup"];
              if (!id || !["complete", "hold", "fail"].includes(mode)) {
                throw new Error("Fixture response is missing its real child plan");
              }
              const { runAgentCleanupStep } =
                await import("openclaw/plugin-sdk/agent-harness-runtime");
              options?.signal?.throwIfAborted();
              const child = fork(path.join(__dirname, "process.cjs"), [origin, id, mode], {
                stdio: ["ignore", "pipe", "pipe", "ipc"],
                env: { ...process.env },
              });
              const closed = new Promise((resolve, reject) => {
                child.once("error", reject);
                child.once("close", (code, signal) => resolve({ code, signal }));
              });
              child.stdout.resume();
              child.stderr.resume();
              const terminate = () => {
                if (child.connected) child.send("terminate");
              };
              const owned = { terminate, closed };
              children.add(owned);
              options?.signal?.addEventListener("abort", terminate, { once: true });
              if (options?.signal?.aborted) terminate();
              try {
                // The pending onResponse promise is tracked by the real transport host.
                // READY and termination ACK never release this physical child owner.
                await runAgentCleanupStep({
                  runId: options?.requestId ?? id,
                  sessionId: "foreground-lifecycle-fixture",
                  step: "foreground-fixture-child",
                  timeoutMs: 30_000,
                  log: api.logger,
                  cleanup: async () => {
                    const outcome = await closed;
                    const receipt = await fetch(new URL(`/child/${id}/closed`, origin), {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(outcome),
                    });
                    if (!receipt.ok || outcome.code !== 0 || outcome.signal !== null) {
                      throw new Error("Fixture child cleanup acknowledgement failed");
                    }
                  },
                });
              } finally {
                options?.signal?.removeEventListener("abort", terminate);
                void closed.then(
                  () => children.delete(owned),
                  () => {},
                );
              }
            },
          });
        // This audited wrapper changes only the response observer, never inference routing.
        return Object.assign(wrapped, { modelRequestBinding: streamFn.modelRequestBinding });
      },
    });
    api.registerService({
      id: "foreground-fixture-children",
      start() {},
      async stop() {
        for (const grant of grants.values()) grant.abort.abort();
        for (const child of children) child.terminate();
        const outcomes = await Promise.allSettled([...children].map((child) => child.closed));
        const failures = outcomes.filter((result) => result.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            failures.map((failure) => failure.reason),
            "Fixture children did not close",
          );
      },
    });
  },
};
