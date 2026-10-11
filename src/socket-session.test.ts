import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeSessionGuard } from "./socket-session.ts";

const harness = (signedIn: boolean) => {
  let checks = 0;
  let signOuts = 0;
  const guard = makeSessionGuard({
    failuresBeforeCheck: 3,
    isSignedIn: Effect.sync(() => {
      checks += 1;
      return signedIn;
    }),
    onSignedOut: Effect.sync(() => {
      signOuts += 1;
    }),
  });
  return { guard, counts: () => ({ checks, signOuts }) };
};

describe("makeSessionGuard", () => {
  it.effect("checks the session only after the configured consecutive failures", () =>
    Effect.gen(function* () {
      const { guard, counts } = harness(false);
      yield* guard.onOpenFailed;
      yield* guard.onOpenFailed;
      assert.deepStrictEqual(counts(), { checks: 0, signOuts: 0 });
      yield* guard.onOpenFailed;
      assert.deepStrictEqual(counts(), { checks: 1, signOuts: 1 });
    }),
  );

  it.effect("a successful open resets the count", () =>
    Effect.gen(function* () {
      const { guard, counts } = harness(false);
      yield* guard.onOpenFailed;
      yield* guard.onOpenFailed;
      yield* guard.onConnect;
      yield* guard.onOpenFailed;
      yield* guard.onOpenFailed;
      assert.deepStrictEqual(counts(), { checks: 0, signOuts: 0 });
    }),
  );

  it.effect("a live session keeps retrying and checks again after another run of failures", () =>
    Effect.gen(function* () {
      const { guard, counts } = harness(true);
      yield* Effect.replicateEffect(guard.onOpenFailed, 6);
      assert.deepStrictEqual(counts(), { checks: 2, signOuts: 0 });
    }),
  );
});
