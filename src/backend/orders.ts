import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { ShopKey } from "../contract/shop.ts";
import { ShopLimits } from "../domain/platform.ts";
import { OrderSyncResponse, orderSyncQuery, orderSyncVariables } from "./order-sync.ts";
import { ShopActors } from "./shop-actors.ts";
import { ShopSessions } from "./shop-sessions.ts";
import { ShopifyAdmin } from "./shopify-admin.ts";

/** What one `orders/*` delivery came to; the delivery is answered 200 for each. */
export type OrderWebhookOutcome = "uninstalled" | "stale" | "refused" | "gone" | "stored";

const make = Effect.gen(function* () {
  const admin = yield* ShopifyAdmin;
  const shopSessions = yield* ShopSessions;
  const actors = yield* ShopActors;

  /**
   * Baton's `fetchAndUpsertOrder`, its fetch half: one `OrderSync` query for `orderId`, or null
   * when Shopify no longer has the order (deleted, or never this shop's), which counts as gone.
   * A page cut short by `hasNextPage` is returned as is and logged at Error: the order is stored
   * flagged rather than silently short (the rule is on `orderSyncQuery`). Fails with
   * `ShopifyAdminError` only.
   */
  const fetchOrder = Effect.fn("Orders.fetchOrder")(function* (shop: ShopKey, orderId: string) {
    const { order } = yield* admin.graphqlDecode(shop, OrderSyncResponse, orderSyncQuery, {
      variables: orderSyncVariables(orderId),
    });
    if (order === null) {
      yield* Effect.logWarning(
        `Orders.fetchOrder: shop=${shop} orderId=${orderId}: order not found`,
      ).pipe(Effect.annotateLogs({ shop, orderId }));
      return null;
    }
    if (order.lineItems.pageInfo.hasNextPage)
      yield* Effect.logError(
        `Orders.fetchOrder: shop=${shop} orderId=${orderId} limit=${String(ShopLimits.maxLineItemsPerOrder)}: line items truncated`,
      ).pipe(Effect.annotateLogs({ shop, orderId, limit: ShopLimits.maxLineItemsPerOrder }));
    return order;
  });

  /**
   * Baton's `syncOrderWebhook`, with the fetch moved out of the actor: the actor's version probe
   * and ceiling (`orderVersion`), then, only for `fetch`, {@link fetchOrder} and the actor's
   * `storeOrder`, which maps, upserts, sweeps when due and notifies. The topic decides nothing
   * (rule 1 on `syncOrder`); a payload no newer than the row spends no Admin call (rule 2). The
   * upsert's own version guard makes a write racing between the probe and the store harmless.
   *
   * The `ShopSession` read comes first, and no row means nothing is touched: an uninstalled
   * shop's actor must never be recreated, and any stub call would recreate it, so an order
   * webhook that arrives after `app/uninstalled` (Shopify does not order deliveries) answers
   * 200 with no actor call. Baton had no such guard.
   *
   * Every refusal is a business answer and succeeds, so the delivery is 2xx and not replayed for
   * four hours to reach the same answer. An `EnsureShopSessionError` fails, so the delivery is
   * non-2xx and Shopify retries, as Baton did: `OfflineSessionMissing` here means the row read
   * above was deleted since (an uninstall racing this delivery), and the retry finds no row and
   * answers 200.
   *
   * The billing seam: the usage flush after a webhook write goes here, after `storeOrder`.
   */
  const syncOrderFromWebhook = Effect.fn("Orders.syncOrderFromWebhook")(function* ({
    shop,
    topic,
    orderId,
    updatedAt,
  }: {
    readonly shop: ShopKey;
    readonly topic: string;
    readonly orderId: string;
    readonly updatedAt: number | null;
  }) {
    const outcome = (status: OrderWebhookOutcome) =>
      Effect.logInfo(
        `Orders.syncOrderFromWebhook: shop=${shop} topic=${topic} orderId=${orderId} status=${status}`,
      ).pipe(Effect.annotateLogs({ shop, topic, orderId, status }), Effect.as(status));
    if (Option.isNone(yield* shopSessions.find(shop))) return yield* outcome("uninstalled");
    const version = yield* actors.orderVersion(shop, { orderId, updatedAt });
    if (version !== "fetch") return yield* outcome(version);
    const order = yield* fetchOrder(shop, orderId);
    if (order === null) return yield* outcome("gone");
    const { lineItems, ...node } = order;
    const { refused } = yield* actors.storeOrder(shop, { order: node, lineItems: lineItems.nodes });
    return yield* outcome(refused ? "refused" : "stored");
  });

  return { fetchOrder, syncOrderFromWebhook };
});

/**
 * The Backend's side of a shop's orders, as Shopify's thing: fetching one and handing it to the
 * shop's actor, which stores it. The actor owns the rows, the version guard and the sweep.
 */
export class Orders extends Context.Service<Orders, Effect.Success<typeof make>>()("app/Orders") {
  static readonly layer = Layer.effect(Orders, make);
}
