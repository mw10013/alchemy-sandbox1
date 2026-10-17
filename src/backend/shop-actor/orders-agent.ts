import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import type { ShopKey } from "../../contract/shop.ts";
import type { SyncOrderResult } from "../../domain/orders.ts";
import { ShopLimits } from "../../domain/platform.ts";
import { ORDERS_KEY } from "../../contract/shop-actor.ts";
import {
  OrderSyncResponse,
  orderSyncQuery,
  orderSyncVariables,
  toOrderLineItems,
  toShopOrder,
} from "../order-sync.ts";
import type { ShopifyAdmin } from "../shopify-admin.ts";
import type { OrderRepository } from "./orders.ts";

/** What one `orders/*` delivery came to in the actor; the delivery is answered 200 for each. */
export type OrderWebhookStatus = "stale" | "refused" | "gone" | "stored";

/**
 * Legacy's `OrdersAgent` (`agent/Orders.ts`): what the shop's actor does with an order as
 * Shopify's thing, fetching one from the Admin API itself and storing it. Built once per
 * activation over the actor's repository, the Backend's `ShopifyAdmin` (which ensures, and so
 * refreshes, the offline session on every call), the actor's `notify` and its shop.
 *
 * No Admin call runs inside the repository's transaction: the transaction closes the object's
 * input gate, behind which a timer never fires, and the refresh's retries and lease poll are
 * timers. Every method fetches first and writes after, as legacy did. The input gate opens
 * during the fetch, so a webhook may interleave with a bulk stream or another webhook; the
 * per-order transactions and the version guard keep that harmless.
 */
export const makeOrdersAgent = <R>({
  repository,
  admin,
  notify,
  shop,
}: {
  readonly repository: OrderRepository;
  readonly admin: (typeof ShopifyAdmin)["Service"];
  readonly notify: (invalidated: ReadonlyArray<string>) => Effect.Effect<void, never, R>;
  readonly shop: ShopKey;
}) => {
  /**
   * Legacy's `fetchAndUpsertOrder`: one `OrderSync` query for `orderId`, then the upsert. A
   * `null` order is not a failure: by the time a delivery is handled the order may already be
   * deleted, and Shopify answers `null` rather than an error, so it is logged and answered as
   * `gone`, storing nothing. A page cut short by `hasNextPage` is stored as is and logged at
   * Error (the rule is on `orderSyncQuery`).
   *
   * After the upsert, the retention pass, rate-limited by `lastSweepAt` rather than run on every
   * delivery (`ShopLimits.sweepIntervalMs`): a busy shop must not pay for a batch of deletes per
   * webhook. Notifies {@link ORDERS_KEY} when the order row moved or the sweep deleted a row, and
   * only then: a sweep is a write the screens show even when the order did not change, and a
   * rewrite of the same version shows nothing new (rule 17).
   */
  const fetchAndUpsertOrder = Effect.fn("OrdersAgent.fetchAndUpsertOrder")(function* (
    orderId: string,
  ) {
    const { order } = yield* admin.graphqlDecode(shop, OrderSyncResponse, orderSyncQuery, {
      variables: orderSyncVariables(orderId),
    });
    if (order === null) {
      yield* Effect.logWarning(
        `OrdersAgent.fetchAndUpsertOrder: shop=${shop} orderId=${orderId}: order not found`,
      ).pipe(Effect.annotateLogs({ shop, orderId }));
      return { _tag: "Gone" } as const;
    }
    if (order.lineItems.pageInfo.hasNextPage)
      yield* Effect.logError(
        `OrdersAgent.fetchAndUpsertOrder: shop=${shop} orderId=${orderId} limit=${String(ShopLimits.maxLineItemsPerOrder)}: line items truncated`,
      ).pipe(Effect.annotateLogs({ shop, orderId, limit: ShopLimits.maxLineItemsPerOrder }));
    const { lineItems, ...node } = order;
    const upsert = yield* repository.upsertOrder({
      order: toShopOrder({ node, syncedAt: yield* Clock.currentTimeMillis }),
      lineItems: yield* toOrderLineItems({ shop, orderId: node.id, nodes: lineItems.nodes }),
    });
    const { written, fresh, changed, refused } = upsert;
    yield* Effect.logInfo(
      `OrdersAgent.fetchAndUpsertOrder: shop=${shop} orderId=${orderId} written=${String(written)} changed=${String(changed)}`,
    ).pipe(Effect.annotateLogs({ shop, orderId, written, changed, refused }));
    const now = yield* Clock.currentTimeMillis;
    const lastSweepAt = yield* repository.lastSweepAt();
    const swept =
      lastSweepAt === null || now - lastSweepAt >= ShopLimits.sweepIntervalMs
        ? yield* repository.sweepExpiredOrders({ now })
        : { orders: 0, runs: 0 };
    const sweptAny = swept.orders > 0 || swept.runs > 0;
    if (sweptAny)
      yield* Effect.logInfo(
        `OrdersAgent.fetchAndUpsertOrder: shop=${shop} sweptOrders=${String(swept.orders)} sweptRuns=${String(swept.runs)}`,
      ).pipe(Effect.annotateLogs({ shop, sweptOrders: swept.orders, sweptRuns: swept.runs }));
    if (changed || sweptAny) yield* notify([ORDERS_KEY]);
    return { _tag: "Upserted", written, fresh, changed, refused } as const;
  });

  /**
   * Legacy's `ShopAgent.syncOrderWebhook`, one round trip for one delivery: the version probe
   * and, for an order not stored, the ceiling (`OrderRepository.orderVersion`), then, only for
   * `Fetch`, {@link fetchAndUpsertOrder}. The topic decides nothing (rule 1 on `syncOrder`); a
   * payload no newer than the row spends no Admin call (rule 2). The upsert's own version guard
   * makes a write racing between the probe and the store harmless. A refusal notifies nothing:
   * it stored no order.
   *
   * Every refusal is a business answer and succeeds. An `EnsureShopSessionError` fails, so the
   * delivery is non-2xx and Shopify retries, as legacy did: the Backend read the shop's
   * `ShopSession` before calling, so `OfflineSessionMissing` here means the row was deleted since
   * (an uninstall racing this delivery), and the retry finds no row and answers 200.
   *
   * The billing seam: the usage flush after a webhook write goes here, after the upsert.
   */
  const syncOrderWebhook = Effect.fn("OrdersAgent.syncOrderWebhook")(function* ({
    orderId,
    updatedAt,
  }: {
    readonly orderId: string;
    readonly topic: string;
    readonly updatedAt: number | null;
  }) {
    const version = yield* repository.orderVersion({
      orderId,
      updatedAt,
      now: yield* Clock.currentTimeMillis,
    });
    const status: OrderWebhookStatus | "fetch" = yield* Match.value(version).pipe(
      Match.tagsExhaustive({
        Stale: () =>
          Effect.logInfo(
            `OrdersAgent.syncOrderWebhook: shop=${shop} orderId=${orderId} status=stale`,
          ).pipe(
            Effect.annotateLogs({ shop, orderId, status: "stale" }),
            Effect.as("stale" as const),
          ),
        Refused: ({ openOrders }) => {
          const limit = ShopLimits.maxOpenOrders;
          return Effect.logError(
            `OrdersAgent.syncOrderWebhook: shop=${shop} orderId=${orderId} status=order-ceiling openOrders=${String(openOrders)} limit=${String(limit)}`,
          ).pipe(
            Effect.annotateLogs({ shop, orderId, status: "order-ceiling", openOrders, limit }),
            Effect.as("refused" as const),
          );
        },
        Fetch: () =>
          Effect.logInfo(
            `OrdersAgent.syncOrderWebhook: shop=${shop} orderId=${orderId} status=fetch`,
          ).pipe(
            Effect.annotateLogs({ shop, orderId, status: "fetch" }),
            Effect.as("fetch" as const),
          ),
      }),
    );
    if (status !== "fetch") return status;
    const fetched = yield* fetchAndUpsertOrder(orderId);
    return Match.value(fetched).pipe(
      Match.tagsExhaustive({
        Gone: (): OrderWebhookStatus => "gone",
        Upserted: ({ refused }): OrderWebhookStatus => (refused ? "refused" : "stored"),
      }),
    );
  });

  /**
   * Sync from Shopify on one order, legacy's `syncOrder`: {@link fetchAndUpsertOrder} without
   * the version probe, since a merchant pressing the button is asking for the fetch and the
   * upsert's own version guard still protects the row.
   *
   * `Gone` when Shopify answers null for the order (the stored row stays, the rule on
   * `SyncOrderResult`); otherwise `Stored`, a ceiling refusal of an order not stored included,
   * as legacy answered: its result knew only gone or not, and the refusal is the ceiling banner's
   * to show, not this button's.
   *
   * The billing seam: the usage flush after a one-order sync goes here, whether or not the fetch
   * succeeded.
   */
  const syncOrder = Effect.fn("OrdersAgent.syncOrder")(function* ({
    orderId,
  }: {
    readonly orderId: string;
  }) {
    const fetched = yield* fetchAndUpsertOrder(orderId);
    const status = Match.value(fetched).pipe(
      Match.tagsExhaustive({
        Gone: () => "gone" as const,
        Upserted: ({ refused }) => (refused ? ("refused" as const) : ("stored" as const)),
      }),
    );
    yield* Effect.logInfo(
      `OrdersAgent.syncOrder: shop=${shop} orderId=${orderId} status=${status}`,
    ).pipe(Effect.annotateLogs({ shop, orderId, status }));
    const result: SyncOrderResult = status === "gone" ? { _tag: "Gone" } : { _tag: "Stored" };
    return result;
  });

  return { fetchAndUpsertOrder, syncOrderWebhook, syncOrder };
};

export type OrdersAgent<R = never> = ReturnType<typeof makeOrdersAgent<R>>;
