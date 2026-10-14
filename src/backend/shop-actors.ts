import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ShopKey } from "../contract/shop.ts";
import type { ShopSnapshot } from "../contract/shop-actor.ts";
import ShopActor from "./shop-actor.ts";

const make = Effect.gen(function* () {
  const actors = yield* ShopActor;

  /**
   * `revoke` on a shop's actor. Best effort: a failure is logged and counts as nothing closed,
   * because the edit that called for it is already written and a stale socket is bounded by
   * its session's expiry.
   */
  const revoke = Effect.fn("ShopActors.revoke")(function* (
    key: ShopKey,
    by: "member" | "session",
    id: string,
  ) {
    return yield* actors
      .getByName(key)
      .revoke({ by, id })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`ShopActors.revoke: shop=${key} by=${by}`, cause).pipe(
            Effect.as({ closed: 0 }),
          ),
        ),
      );
  });

  const snapshot = Effect.fn("ShopActors.snapshot")(function* (key: ShopKey) {
    return yield* actors.getByName(key).snapshot();
  });

  return { revoke, snapshot };
});

/**
 * The Backend's own calls on a shop's actor: schemaless methods on its stub, which only the
 * Backend holds. A browser reaches the actor only through its socket.
 */
export class ShopActors extends Context.Service<ShopActors, Effect.Success<typeof make>>()(
  "app/ShopActors",
) {
  static readonly layer = Layer.effect(ShopActors, make);

  /** Records each revoke and closes nothing, and answers every snapshot with `snapshot`. */
  static readonly layerTest = (
    revoked: Array<{ key: ShopKey; by: "member" | "session"; id: string }>,
    snapshot: ShopSnapshot = { count: { value: 0 }, activation: { id: "test" } },
  ) =>
    Layer.succeed(ShopActors, {
      revoke: (key, by, id) =>
        Effect.sync(() => {
          revoked.push({ key, by, id });
          return { closed: 0 };
        }),
      snapshot: () => Effect.succeed(snapshot),
    });
}
