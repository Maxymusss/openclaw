import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";

type FixtureFailure = { error: unknown };
type HeldFixtureOwner = {
  signal: AbortSignal;
  track: ReturnType<typeof createFixtureLifetime>["track"];
};

// The caller supplies its real hook, including suites that mock Vitest registration.
export function createGatewayHeldFixtureRunner(registerFinished: (report: () => void) => unknown) {
  let finishHeldFixture: (() => Promise<void>) | undefined;

  async function run(
    release: () => void,
    body: (owner: HeldFixtureOwner) => Promise<void>,
    dispose: () => Promise<void> = async () => {},
  ): Promise<void> {
    const lifetime = createFixtureLifetime();
    const finalization = createFixtureLifetime();
    const controller = new AbortController();
    const cleanup: { failure?: FixtureFailure } = {};
    // Admit finalization before the body; its separate claim outlives producer drain.
    void finalization.acquire(async () => ({
      cleanup: async () => {
        for (const step of [release, () => lifetime.cleanup(), dispose]) {
          try {
            await step();
          } catch (error) {
            cleanup.failure = {
              error: cleanup.failure
                ? new AggregateError([cleanup.failure.error, error], "fixture cleanup failed", {
                    cause: cleanup.failure.error,
                  })
                : error,
            };
          }
        }
        if (cleanup.failure) throw cleanup.failure.error;
      },
    }));
    let hookTeardown = false;
    let cleanupReported = false;
    let finished: Promise<void> | undefined;
    const finish = () =>
      (finished ??= (async () => {
        // Retire synchronously so an early hook cannot start the scheduled body.
        controller.abort(new Error("fixture is finishing"));
        await finalization.cleanup();
      })().catch((error: unknown) => {
        // Keep the original phase error; the outer owner wraps required failures.
        cleanup.failure ??= { error };
      }));

    finishHeldFixture = () => {
      hookTeardown = true;
      return finish();
    };
    registerFinished(() => {
      // Joining belongs to afterEach; reporting later cannot skip inherited resets.
      if (cleanup.failure && !cleanupReported) {
        cleanupReported = true;
        throw cleanup.failure.error;
      }
    });
    const scenario = lifetime.run(() => {
      controller.signal.throwIfAborted();
      return body({ signal: controller.signal, track: lifetime.track });
    });
    let primary: FixtureFailure | undefined;
    try {
      await scenario;
    } catch (error) {
      primary = { error };
    } finally {
      await finish();
    }
    if (cleanup.failure) {
      cleanupReported = !hookTeardown;
      if (primary) {
        throw new AggregateError(
          [primary.error, cleanup.failure.error],
          "fixture and cleanup failed",
          { cause: primary.error },
        );
      }
      throw cleanup.failure.error;
    }
    if (primary) {
      throw primary.error;
    }
  }

  async function finishAfterEach(): Promise<void> {
    const finish = finishHeldFixture;
    finishHeldFixture = undefined;
    await finish?.();
  }

  return { run, finishAfterEach };
}
