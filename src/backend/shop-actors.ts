import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ShopKey } from "../contract/shop.ts";
import type { OrdersListInput, ShopSnapshot } from "../contract/shop-actor.ts";
import * as Match from "effect/Match";
import { FixtureConflict } from "../contract/fixture.ts";
import * as Schema from "effect/Schema";
import { OrdersSyncFailure } from "../contract/shopify.ts";
import type { ActorFixtureRows } from "./fixture.ts";
import ShopActor, { ABORT_UNINSTALLED } from "./shop-actor.ts";

/**
 * `ShopActors.destroy`'s reading of the stub call (legacy's `destroyShopAgent`). The actor's abort
 * lands mid-call, so a successful destroy rejects: the stub fails with an `RpcCallError` whose
 * cause is workerd's reset, an `Error` with message {@link ABORT_UNINSTALLED} (and
 * `durableObjectReset: true`). That rejection, and only that, is success: the abort comes after
 * `deleteAll`, so seeing it proves the storage is gone. A call that answers before its abort
 * lands is success too. Anything else (the actor unreachable, or `deleteAll` hitting its time
 * limit, which is safe to retry until it succeeds) logs `status=failed` and propagates, so the
 * uninstall answers non-2xx and Shopify retries.
 *
 * The stub types its methods' errors as `never`, but the rejection arrives as a typed failure,
 * so this reads the cause.
 */
export const settleDestroy = (key: ShopKey, call: Effect.Effect<void>) =>
  call.pipe(
    Effect.catchCause((cause) =>
      isUninstallAbort(Cause.squash(cause)) ? Effect.void : Effect.failCause(cause),
    ),
    Effect.tap(() =>
      Effect.logInfo(`ShopActors.destroy: shop=${key} status=destroyed`).pipe(
        Effect.annotateLogs({ shop: key, status: "destroyed" }),
      ),
    ),
    Effect.tapCause((cause) =>
      Effect.logError(
        `ShopActors.destroy: shop=${key} status=failed: ${messageOf(Cause.squash(cause))}`,
      ).pipe(Effect.annotateLogs({ shop: key, status: "failed" })),
    ),
  );

const decodeSyncFailure = Schema.decodeUnknownEffect(OrdersSyncFailure);

const isUninstallAbort = (error: unknown) =>
  error instanceof Cloudflare.RpcCallError &&
  error.cause instanceof Error &&
  error.cause.message === ABORT_UNINSTALLED;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

  /** Deletes one stored order; see `removeOrder` on {@link ShopActor}. */
  const removeOrder = Effect.fn("ShopActors.removeOrder")(function* (
    key: ShopKey,
    orderId: string,
  ) {
    return yield* actors.getByName(key).removeOrder({ orderId });
  });

  /**
   * One `orders/*` delivery for an installed shop; see `syncOrderWebhook` on {@link ShopActor}.
   * Call it only after reading the shop's `ShopSession`: any stub call recreates an uninstalled
   * shop's actor.
   */
  const syncOrderWebhook = Effect.fn("ShopActors.syncOrderWebhook")(function* (
    key: ShopKey,
    input: { readonly orderId: string; readonly topic: string; readonly updatedAt: number | null },
  ) {
    return yield* actors.getByName(key).syncOrderWebhook(input);
  });

  /**
   * Sync from Shopify on one order; see `syncOrder` on {@link ShopActor}. Its `Failed` answer is
   * re-raised as the {@link OrdersSyncFailure} it carries.
   */
  const syncOrder = Effect.fn("ShopActors.syncOrder")(function* (key: ShopKey, orderId: string) {
    const answer = yield* actors.getByName(key).syncOrder({ orderId });
    if (answer._tag !== "Failed") return answer;
    return yield* Effect.flatMap(decodeSyncFailure(answer.failure).pipe(Effect.orDie), Effect.fail);
  });

  /**
   * Sync open orders; see `syncOpenOrders` on {@link ShopActor}. Its `Failed` answer is re-raised
   * as `syncOrder`'s is.
   */
  const syncOpenOrders = Effect.fn("ShopActors.syncOpenOrders")(function* (key: ShopKey) {
    const answer = yield* actors.getByName(key).syncOpenOrders();
    if (answer._tag !== "Failed") return answer;
    return yield* Effect.flatMap(decodeSyncFailure(answer.failure).pipe(Effect.orDie), Effect.fail);
  });

  /** One stored order with its items, or null. */
  const getOrder = Effect.fn("ShopActors.getOrder")(function* (key: ShopKey, orderId: string) {
    return yield* actors.getByName(key).getOrder({ orderId });
  });

  /** One page of the shop's orders, newest first. */
  const listOrders = Effect.fn("ShopActors.listOrders")(function* (
    key: ShopKey,
    input: OrdersListInput,
  ) {
    return yield* actors.getByName(key).listOrders(input);
  });

  /** Streams a completed export into the shop; see `onOrdersStream` on {@link ShopActor}. */
  const onOrdersStream = Effect.fn("ShopActors.onOrdersStream")(function* (
    key: ShopKey,
    input: { readonly workflowId: string; readonly url: string },
  ) {
    return yield* actors.getByName(key).onOrdersStream(input);
  });

  /** Ends a sync that found nothing; see `onOrdersSyncEmpty` on {@link ShopActor}. */
  const onOrdersSyncEmpty = Effect.fn("ShopActors.onOrdersSyncEmpty")(function* (
    key: ShopKey,
    input: { readonly workflowId: string },
  ) {
    yield* actors.getByName(key).onOrdersSyncEmpty(input);
  });

  /** Ends a sync that failed; see `onOrdersSyncError` on {@link ShopActor}. */
  const onOrdersSyncError = Effect.fn("ShopActors.onOrdersSyncError")(function* (
    key: ShopKey,
    input: { readonly workflowId: string; readonly message: string },
  ) {
    yield* actors.getByName(key).onOrdersSyncError(input);
  });

  /** Destroys the shop's actor; see `destroy` on {@link ShopActor} and {@link settleDestroy}. */
  const destroy = Effect.fn("ShopActors.destroy")(function* (key: ShopKey) {
    yield* settleDestroy(key, actors.getByName(key).destroy());
  });

  return {
    destroy,
    revoke,
    snapshot,
    loadFixture,
    addFixture,
    removeOrder,
    syncOrderWebhook,
    syncOrder,
    getOrder,
    listOrders,
    syncOpenOrders,
    onOrdersStream,
    onOrdersSyncEmpty,
    onOrdersSyncError,
  };
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
   * Records each revoke and closes nothing, answers every snapshot with `snapshot`, records
   * each fixture load in `loaded` and each fixture add in `added`, answering the counts of its
   * rows (it never finds a clash), and records each order removal in `removedOrders`, answering
   * that there was one. Its order and sync methods and `destroy` die: a test that reaches them
   * overrides them.
   */
  static readonly layerTest = (
    revoked: Array<{ key: ShopKey; by: "member" | "session"; id: string }>,
    snapshot: ShopSnapshot = { count: { value: 0 }, activation: { id: "test" } },
    loaded: Array<{ key: ShopKey; rows: ActorFixtureRows }> = [],
    added: Array<{ key: ShopKey; rows: ActorFixtureRows }> = [],
    removedOrders: Array<{ key: ShopKey; orderId: string }> = [],
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
      removeOrder: (key, orderId) =>
        Effect.sync(() => {
          removedOrders.push({ key, orderId });
          return { removed: true };
        }),
      syncOrderWebhook: () => Effect.die(new Error("ShopActors.layerTest: syncOrderWebhook")),
      syncOrder: () => Effect.die(new Error("ShopActors.layerTest: syncOrder")),
      getOrder: () => Effect.die(new Error("ShopActors.layerTest: getOrder")),
      listOrders: () => Effect.die(new Error("ShopActors.layerTest: listOrders")),
      syncOpenOrders: () => Effect.die(new Error("ShopActors.layerTest: syncOpenOrders")),
      onOrdersStream: () => Effect.die(new Error("ShopActors.layerTest: onOrdersStream")),
      onOrdersSyncEmpty: () => Effect.die(new Error("ShopActors.layerTest: onOrdersSyncEmpty")),
      onOrdersSyncError: () => Effect.die(new Error("ShopActors.layerTest: onOrdersSyncError")),
      destroy: () => Effect.die(new Error("ShopActors.layerTest: destroy")),
    });
}
