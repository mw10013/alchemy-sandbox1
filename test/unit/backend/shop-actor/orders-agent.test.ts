import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { ORDERS_KEY } from "../../../../src/contract/shop-actor.ts";
import { orderSyncQuery, orderSyncVariables } from "../../../../src/backend/order-sync.ts";
import { makeOrdersAgent } from "../../../../src/backend/shop-actor/orders-agent.ts";
import { ReauthorizationRequired } from "../../../../src/backend/shopify.ts";
import { ShopifyAdmin, type ShopifyAdminError } from "../../../../src/backend/shopify-admin.ts";
import { ShopLimits } from "../../../../src/domain/platform.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";
import recorded from "../fixtures/order-sync-response.json";
import {
  ActorSqliteTest,
  type AdminCall,
  QuietLogs,
  testOrderRepository,
  testShopifyAdmin,
} from "../layers.ts";

/**
 * The actor's one-order fetch over a fresh in-memory SQLite migrated by the actor's own schema
 * and a scripted `ShopifyAdmin`: the webhook's probe, ceiling and fetch, and Sync from Shopify.
 */

/** The order the recorded `OrderSync` answer is for, and its version. */
const ORDER_GID = "gid://shopify/Order/6123456789012";
const ORDER_UPDATED_AT = Date.parse("2026-10-15T09:30:45Z");

/**
 * `body` with an `OrdersAgent` for {@link SEED_SHOP} over a fresh database and `replies`, the
 * Admin calls and the notices recorded.
 */
const withAgent = <A, E>(
  replies: Array<Effect.Effect<unknown, ShopifyAdminError>>,
  body: (
    agent: ReturnType<typeof makeOrdersAgent<never>>,
    recorded: {
      readonly admin: Array<AdminCall>;
      readonly notices: Array<ReadonlyArray<string>>;
      readonly repository: Effect.Success<typeof testOrderRepository>;
      readonly sql: SqlClient.SqlClient;
    },
  ) => Effect.Effect<A, E>,
) => {
  const admin: Array<AdminCall> = [];
  const notices: Array<ReadonlyArray<string>> = [];
  return Effect.gen(function* () {
    const repository = yield* testOrderRepository;
    const agent = makeOrdersAgent({
      repository,
      admin: yield* ShopifyAdmin,
      notify: (invalidated) =>
        Effect.sync(() => {
          notices.push(invalidated);
        }),
      shop: SEED_SHOP,
    });
    return yield* body(agent, { admin, notices, repository, sql: yield* SqlClient.SqlClient });
  }).pipe(
    Effect.provide(testShopifyAdmin(replies, admin)),
    Effect.provide(ActorSqliteTest),
    Effect.provide(QuietLogs),
  );
};

/** Fills the order ceiling with open orders straight to SQL; ids never collide with a test's. */
const fillCeiling = (sql: SqlClient.SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      for (let i = 1; i <= ShopLimits.maxOpenOrders; i++)
        yield* sql`
          insert into ShopOrder (id, legacyId, name, processedAt, updatedAt, cancelledAt, fulfillmentStatus, fullyPaid, note, syncedAt)
          values (${`gid://shopify/Order/open-${String(i)}`}, ${`open-${String(i)}`}, ${`#open-${String(i)}`}, 0, 0, null, 'UNFULFILLED', 1, null, 0)
        `;
    }),
  );

const ordersLimitedAt = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly ordersLimitedAt: number | null;
  }>`select ordersLimitedAt from ShopUsage where id = 1`.pipe(
    Effect.map(([row]) => row?.ordersLimitedAt ?? null),
  );

const reauthorization = new ReauthorizationRequired({
  shop: SEED_SHOP,
  reason: "refresh-token-rejected",
  refreshTokenExpiresAt: null,
});

describe("OrdersAgent.syncOrderWebhook", () => {
  it.effect("fetches the order it names and stores it with its line items, and notifies", () =>
    withAgent([Effect.succeed(recorded.data)], (agent, { admin, notices, repository }) =>
      Effect.gen(function* () {
        const status = yield* agent.syncOrderWebhook({
          orderId: ORDER_GID,
          topic: "ORDERS_PAID",
          updatedAt: ORDER_UPDATED_AT,
        });
        assert.strictEqual(status, "stored");
        assert.deepStrictEqual(admin, [
          { shop: SEED_SHOP, query: orderSyncQuery, variables: orderSyncVariables(ORDER_GID) },
        ]);
        const stored = Option.getOrNull(yield* repository.getOrder(ORDER_GID));
        assert.strictEqual(stored?.order.name, "#1042");
        assert.deepStrictEqual(
          stored?.lineItems.map(({ id }) => id),
          ["gid://shopify/LineItem/15234567890123", "gid://shopify/LineItem/15234567890124"],
        );
        assert.deepStrictEqual(notices, [[ORDERS_KEY]]);
      }),
    ),
  );

  it.effect("a stale version skips the fetch and notifies nothing", () =>
    withAgent([Effect.succeed(recorded.data)], (agent, { admin, notices }) =>
      Effect.gen(function* () {
        yield* agent.syncOrder({ orderId: ORDER_GID });
        admin.length = 0;
        notices.length = 0;
        for (const updatedAt of [ORDER_UPDATED_AT - 1, ORDER_UPDATED_AT])
          assert.strictEqual(
            yield* agent.syncOrderWebhook({ orderId: ORDER_GID, topic: "ORDERS_PAID", updatedAt }),
            "stale",
          );
        assert.deepStrictEqual(admin, []);
        assert.deepStrictEqual(notices, []);
      }),
    ),
  );

  it.effect("a new order at the ceiling marks ordersLimitedAt and skips the fetch", () =>
    withAgent([], (agent, { admin, notices, sql, repository }) =>
      Effect.gen(function* () {
        yield* fillCeiling(sql);
        const status = yield* agent.syncOrderWebhook({
          orderId: ORDER_GID,
          topic: "ORDERS_CREATE",
          updatedAt: ORDER_UPDATED_AT,
        });
        assert.strictEqual(status, "refused");
        assert.deepStrictEqual(admin, []);
        assert.isNotNull(yield* ordersLimitedAt(sql));
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
        assert.deepStrictEqual(notices, []);
      }),
    ),
  );

  it.effect("an order Shopify answers null for is gone and stores nothing", () =>
    withAgent([Effect.succeed({ order: null })], (agent, { admin, notices, repository }) =>
      Effect.gen(function* () {
        const status = yield* agent.syncOrderWebhook({
          orderId: ORDER_GID,
          topic: "ORDERS_CANCELLED",
          updatedAt: null,
        });
        assert.strictEqual(status, "gone");
        assert.lengthOf(admin, 1);
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
        assert.deepStrictEqual(notices, []);
      }),
    ),
  );

  it.effect("an EnsureShopSessionError fails the delivery and stores nothing", () =>
    withAgent([Effect.fail(reauthorization)], (agent, { repository }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          agent.syncOrderWebhook({ orderId: ORDER_GID, topic: "ORDERS_CREATE", updatedAt: null }),
        );
        assert.strictEqual(error._tag, "ReauthorizationRequired");
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
      }),
    ),
  );
});

describe("OrdersAgent.syncOrder", () => {
  it.effect("the one-order sync fetches the order and stores it, with no version probe", () =>
    withAgent(
      [Effect.succeed(recorded.data), Effect.succeed(recorded.data)],
      (agent, { admin, repository }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* agent.syncOrder({ orderId: ORDER_GID }), {
            _tag: "Stored",
          });
          // The same version again still asks Shopify: there is no probe.
          assert.deepStrictEqual(yield* agent.syncOrder({ orderId: ORDER_GID }), {
            _tag: "Stored",
          });
          assert.deepStrictEqual(admin, [
            { shop: SEED_SHOP, query: orderSyncQuery, variables: orderSyncVariables(ORDER_GID) },
            { shop: SEED_SHOP, query: orderSyncQuery, variables: orderSyncVariables(ORDER_GID) },
          ]);
          assert.lengthOf(
            Option.getOrNull(yield* repository.getOrder(ORDER_GID))?.lineItems ?? [],
            2,
          );
        }),
    ),
  );

  it.effect("an order Shopify no longer has answers Gone and stores nothing", () =>
    withAgent([Effect.succeed({ order: null })], (agent, { admin, repository }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* agent.syncOrder({ orderId: ORDER_GID }), { _tag: "Gone" });
        assert.lengthOf(admin, 1);
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
      }),
    ),
  );

  /** Legacy's answer knew only gone or not: the ceiling is the banner's to show. */
  it.effect("a new order refused at the ceiling answers Stored", () =>
    withAgent([Effect.succeed(recorded.data)], (agent, { sql, repository }) =>
      Effect.gen(function* () {
        yield* fillCeiling(sql);
        assert.deepStrictEqual(yield* agent.syncOrder({ orderId: ORDER_GID }), {
          _tag: "Stored",
        });
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
      }),
    ),
  );

  it.effect("an EnsureShopSessionError fails the sync and stores nothing", () =>
    withAgent([Effect.fail(reauthorization)], (agent, { repository }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(agent.syncOrder({ orderId: ORDER_GID }));
        assert.strictEqual(error._tag, "ReauthorizationRequired");
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
      }),
    ),
  );
});
