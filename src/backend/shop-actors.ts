import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ShopKey } from "../contract/shop.ts";
import type { ShopSnapshot } from "../contract/shop-actor.ts";
import * as Match from "effect/Match";
import { FixtureConflict } from "../contract/fixture.ts";
import type { ActorFixtureRows } from "./fixture.ts";
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

  /** Replaces the shop's work with `rows`; see `loadFixture` on {@link ShopActor}. */
  const loadFixture = Effect.fn("ShopActors.loadFixture")(function* (
    key: ShopKey,
    rows: ActorFixtureRows,
  ) {
    return yield* actors.getByName(key).loadFixture(rows);
  });

  /**
   * Adds `rows` beside the shop's work; see `addFixture` on {@link ShopActor}. Its `Conflict`
   * answer is {@link FixtureConflict}.
   */
  const addFixture = Effect.fn("ShopActors.addFixture")(function* (
    key: ShopKey,
    rows: ActorFixtureRows,
  ) {
    const answer = yield* actors.getByName(key).addFixture(rows);
    return yield* Match.value(answer).pipe(
      Match.tagsExhaustive({
        Added: ({ counts }) => Effect.succeed(counts),
        Conflict: ({ reason }) => Effect.fail(new FixtureConflict({ shop: key, reason })),
      }),
    );
  });

  return { revoke, snapshot, loadFixture, addFixture };
});

/**
 * The Backend's own calls on a shop's actor: schemaless methods on its stub, which only the
 * Backend holds. A browser reaches the actor only through its socket.
 */
export class ShopActors extends Context.Service<ShopActors, Effect.Success<typeof make>>()(
  "app/ShopActors",
) {
  static readonly layer = Layer.effect(ShopActors, make);

  /**
   * Records each revoke and closes nothing, answers every snapshot with `snapshot`, and records
   * each fixture load in `loaded` and each fixture add in `added`, answering the counts of its
   * rows; it never finds a clash.
   */
  static readonly layerTest = (
    revoked: Array<{ key: ShopKey; by: "member" | "session"; id: string }>,
    snapshot: ShopSnapshot = { count: { value: 0 }, activation: { id: "test" } },
    loaded: Array<{ key: ShopKey; rows: ActorFixtureRows }> = [],
    added: Array<{ key: ShopKey; rows: ActorFixtureRows }> = [],
  ) =>
    Layer.succeed(ShopActors, {
      revoke: (key, by, id) =>
        Effect.sync(() => {
          revoked.push({ key, by, id });
          return { closed: 0 };
        }),
      snapshot: () => Effect.succeed(snapshot),
      loadFixture: (key, rows) =>
        Effect.sync(() => {
          loaded.push({ key, rows });
          return {
            workflows: rows.workflows.length,
            orders: rows.orders.length,
            lineItems: rows.lineItems.length,
          };
        }),
      addFixture: (key, rows) =>
        Effect.sync(() => {
          added.push({ key, rows });
          return {
            workflows: rows.workflows.length,
            orders: rows.orders.length,
            lineItems: rows.lineItems.length,
          };
        }),
    });
}
