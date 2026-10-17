import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { orderSyncQuery, orderSyncVariables } from "../../../src/backend/order-sync.ts";
import { Orders } from "../../../src/backend/orders.ts";
import type { ShopSessionRow } from "../../../src/backend/shop-sessions.ts";
import { ReauthorizationRequired } from "../../../src/backend/shopify.ts";
import type { ShopifyAdminError } from "../../../src/backend/shopify-admin.ts";
import { SEED_SHOP } from "../../seed-shops.ts";
import recorded from "./fixtures/order-sync-response.json";
import {
  type AdminCall,
  type OrderActorCalls,
  QuietLogs,
  testOrderActors,
  testOrdersSyncWorkflows,
  testShopify,
  testShopifyAdmin,
} from "./layers.ts";

const session: ShopSessionRow = {
  shop: SEED_SHOP,
  shopGid: "gid://shopify/Shop/1",
  shopActorId: SEED_SHOP,
  scope: "read_products",
  accessTokenExpiresAt: 1_900_000_000_000,
  accessToken: "shpat_secret_access",
  refreshToken: "shprt_secret_refresh",
  refreshTokenExpiresAt: 1_900_000_000_000,
  refreshLeaseUntil: null,
  planHandle: null,
  planHandleExpiresAt: null,
  planBoundaryAt: null,
};

/** The order the recorded `OrderSync` answer is for. */
const ORDER_GID = "gid://shopify/Order/6123456789012";

interface Calls extends OrderActorCalls {
  readonly admin: Array<AdminCall>;
}

/**
 * {@link Orders} over {@link testShopify} holding `rows`, {@link testOrderActors} (its
 * `storeOrder` refused when `refused`) and {@link testShopifyAdmin} answering `replies`, each
 * recording into the returned `calls`.
 */
const ordersWith = ({
  rows = [session],
  replies = [],
  refused = false,
}: {
  rows?: ReadonlyArray<ShopSessionRow>;
  replies?: Array<Effect.Effect<unknown, ShopifyAdminError>>;
  refused?: boolean;
}) => {
  const calls: Calls = { versions: [], stored: [], destroyed: [], admin: [] };
  const layer = Orders.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        testOrderActors(calls, "fetch", Effect.void, refused),
        testShopifyAdmin(replies, calls.admin),
        testOrdersSyncWorkflows(),
      ),
    ),
    Layer.provide(testShopify(rows)),
    Layer.provide(QuietLogs),
  );
  return { calls, layer };
};

const syncOrder = Effect.gen(function* () {
  return yield* (yield* Orders).syncOrder(SEED_SHOP, ORDER_GID);
});

describe("Orders.syncOrder", () => {
  it.effect("the one-order sync fetches the order and stores it, with no version probe", () => {
    const { calls, layer } = ordersWith({ replies: [Effect.succeed(recorded.data)] });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* syncOrder, { _tag: "Stored" });
      assert.deepStrictEqual(calls.versions, []);
      assert.deepStrictEqual(calls.admin, [
        { shop: SEED_SHOP, query: orderSyncQuery, variables: orderSyncVariables(ORDER_GID) },
      ]);
      assert.lengthOf(calls.stored, 1);
      assert.strictEqual(calls.stored[0]?.order.id, ORDER_GID);
      assert.notProperty(calls.stored[0]?.order, "lineItems");
      assert.lengthOf(calls.stored[0]?.lineItems ?? [], 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an order Shopify no longer has answers Gone and stores nothing", () => {
    const { calls, layer } = ordersWith({ replies: [Effect.succeed({ order: null })] });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* syncOrder, { _tag: "Gone" });
      assert.lengthOf(calls.admin, 1);
      assert.deepStrictEqual(calls.stored, []);
    }).pipe(Effect.provide(layer));
  });

  /** Legacy's answer knew only gone or not: the ceiling is the banner's to show. */
  it.effect("a new order refused at the ceiling answers Stored", () => {
    const { calls, layer } = ordersWith({
      replies: [Effect.succeed(recorded.data)],
      refused: true,
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* syncOrder, { _tag: "Stored" });
      assert.lengthOf(calls.stored, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a shop with no session is ShopNotInstalled and its actor is not called", () => {
    const { calls, layer } = ordersWith({ rows: [] });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(syncOrder);
      assert.strictEqual(error._tag, "ShopNotInstalled");
      assert.deepStrictEqual(calls, { versions: [], stored: [], destroyed: [], admin: [] });
    }).pipe(Effect.provide(layer));
  });

  it.effect("an EnsureShopSessionError fails the sync and stores nothing", () => {
    const { calls, layer } = ordersWith({
      replies: [
        Effect.fail(
          new ReauthorizationRequired({
            shop: SEED_SHOP,
            reason: "refresh-token-rejected",
            refreshTokenExpiresAt: null,
          }),
        ),
      ],
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(syncOrder);
      assert.strictEqual(error._tag, "ReauthorizationRequired");
      assert.deepStrictEqual(calls.stored, []);
    }).pipe(Effect.provide(layer));
  });
});
