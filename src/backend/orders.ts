import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ShopNotInstalled } from "../contract/fixture.ts";
import type { ShopKey } from "../contract/shop.ts";
import type { OrdersSyncResult } from "../domain/orders.ts";
import { OrdersSyncWorkflows } from "./orders-sync-workflow.ts";
import { ShopActors } from "./shop-actors.ts";
import { ShopSessions } from "./shop-sessions.ts";

const make = Effect.gen(function* () {
  const shopSessions = yield* ShopSessions;
  const actors = yield* ShopActors;
  const workflows = yield* OrdersSyncWorkflows;

  /**
   * Sync open orders, the Backend's half of legacy's `syncOpenOrders`: the session read (no row
   * fails {@link ShopNotInstalled} with no actor call, as every background path guards), then the
   * actor's `beginSync` under a fresh instance id, then, only on `Started`, the
   * `OrdersSyncWorkflow` instance of that id. The actor records the sync before the instance
   * exists, so a second press in between answers `InFlight`.
   *
   * A create that fails ends the sync it recorded through the actor's `syncFailed`, whose
   * message becomes the banner, and fails on: the button is enabled again at once rather than
   * after `SYNC_STALE_MS`.
   */
  const beginOpenOrdersSync = Effect.fn("Orders.beginOpenOrdersSync")(function* (shop: ShopKey) {
    if (Option.isNone(yield* shopSessions.find(shop))) return yield* new ShopNotInstalled({ shop });
    const workflowId = crypto.randomUUID();
    const result: OrdersSyncResult = yield* actors.beginSync(shop, {
      workflowId,
      now: yield* Clock.currentTimeMillis,
    });
    if (result._tag !== "Started") return result;
    yield* workflows.create({ id: workflowId, params: { shop } }).pipe(
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          const error = Cause.squash(cause);
          const message = error instanceof Error ? error.message : String(error);
          yield* Effect.logError(
            `Orders.beginOpenOrdersSync: shop=${shop} workflowId=${workflowId} status=create-failed: ${message}`,
          ).pipe(Effect.annotateLogs({ shop, workflowId, status: "create-failed" }));
          yield* actors.syncFailed(shop, { workflowId, message });
        }),
      ),
    );
    return result;
  });

  return { beginOpenOrdersSync };
});

/**
 * The Backend's side of a shop's orders: starting the open-orders sync. The actor owns the rows,
 * the version guard, the sweep and the one-order fetch.
 */
export class Orders extends Context.Service<Orders, Effect.Success<typeof make>>()("app/Orders") {
  static readonly layer = Layer.effect(Orders, make);
}
