import * as Effect from "effect/Effect";

/**
 * Connection hooks for a socket whose refused upgrade a browser cannot tell from an outage:
 * after `failuresBeforeCheck` consecutive failed opens, `isSignedIn` asks the Backend over
 * HTTP, where a 401 is visible, and `onSignedOut` runs when it says no. A successful open
 * resets the count, so a flaky network alone never triggers the check. The socket's own retry
 * is never capped: it is what reconnects a tab after the machine slept.
 */
export const makeSessionGuard = (options: {
  readonly failuresBeforeCheck: number;
  readonly isSignedIn: Effect.Effect<boolean>;
  readonly onSignedOut: Effect.Effect<void>;
}) => {
  let failures = 0;
  return {
    onConnect: Effect.sync(() => {
      failures = 0;
    }),
    onOpenFailed: Effect.gen(function* () {
      failures += 1;
      if (failures < options.failuresBeforeCheck) return;
      failures = 0;
      if (!(yield* options.isSignedIn)) yield* options.onSignedOut;
    }),
  };
};
