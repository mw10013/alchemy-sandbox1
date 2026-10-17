import { Memory } from "@alchemy.run/better-auth";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import type { Member } from "../../../src/contract/members.ts";
import type { ShopKey } from "../../../src/contract/shop.ts";
import type { LineItemNode, OrderNode } from "../../../src/backend/order-sync.ts";
import { ShopifyAdmin, type ShopifyAdminError } from "../../../src/backend/shopify-admin.ts";
import { ShopActors } from "../../../src/backend/shop-actors.ts";
import { migrations, syncTransaction } from "../../../src/backend/shop-actor.ts";
import { makeOrderRepository } from "../../../src/backend/shop-actor/orders.ts";
import { Auth } from "../../../src/backend/auth.ts";
import { MagicLinkDelivery } from "../../../src/backend/magic-link-delivery.ts";
import { Mailer } from "../../../src/backend/mailer.ts";
import { Members } from "../../../src/backend/members.ts";
import { ShopSessions, type ShopSessionRow } from "../../../src/backend/shop-sessions.ts";
import { SHOPIFY_API_KEY, SHOPIFY_API_SECRET_FAKE, Shopify } from "../../../src/backend/shopify.ts";

/** The `AUTH_ORIGIN` the test Backend's Better Auth runs under, so links resolve against it. */
export const TEST_ORIGIN = "http://test.local";

/**
 * The test app's API key and secret, which {@link testShopify} verifies tokens against: the fake
 * app's, so `mintSessionToken`'s defaults sign for it.
 */
export const TEST_SHOPIFY_APP = {
  apiKey: SHOPIFY_API_KEY,
  apiSecret: SHOPIFY_API_SECRET_FAKE,
} as const;

/**
 * {@link Shopify} over {@link TEST_SHOPIFY_APP} and an in-memory {@link ShopSessions} holding
 * `rows`, which stays in the context so a test can read what an exchange wrote.
 */
export const testShopify = (rows: ReadonlyArray<ShopSessionRow> = []) =>
  Shopify.layerWith({
    apiKey: TEST_SHOPIFY_APP.apiKey,
    apiSecret: Redacted.make(TEST_SHOPIFY_APP.apiSecret),
    appUrl: "http://localhost",
  }).pipe(Layer.provideMerge(ShopSessions.layerTest(rows)));

/** Drops `Info` and below, so only a warning or error reaches the test output. */
export const QuietLogs = Layer.succeed(References.MinimumLogLevel, "Warn");

/**
 * {@link Auth} over Better Auth on an in-memory database, fresh per test, with the services
 * every Backend test needs: {@link Members}, the given {@link ShopActors} fake, and the stage's
 * {@link MagicLinkDelivery} over {@link Mailer.layerTest}. `extra` adds what only one test
 * needs, such as `ShopAccess`. Alchemy's runtime marker is left to the caller: a test that calls
 * Worker methods directly needs it in its context (`provideMerge`), the others only feed it.
 */
export const testAuth = <A, E, R>({
  members,
  actors,
  delivery,
  extra,
}: {
  members: ReadonlyArray<Member>;
  actors: Layer.Layer<ShopActors>;
  delivery: "inline" | "mailed";
  extra: Layer.Layer<A, E, R>;
}) =>
  Auth.layerWith({ secret: "test-secret-test-secret-test-secret" }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Members.layerTest(members),
        actors,
        extra,
        (delivery === "inline"
          ? MagicLinkDelivery.layerInline
          : MagicLinkDelivery.layerMailed
        ).pipe(Layer.provideMerge(Mailer.layerTest)),
      ),
    ),
    Layer.provide(Memory()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ AUTH_ORIGIN: TEST_ORIGIN }))),
  );

/**
 * The shop actor's SQLite in memory, migrated by the actor's own `migrations`, fresh per
 * provide: `node:sqlite` through `@effect/sql-sqlite-node`, which runs one statement per `sql`
 * call, as `migrations` is written for.
 */
export const ActorSqliteTest = Layer.effectDiscard(
  SqliteMigrator.run({ loader: migrations }).pipe(Effect.orDie),
).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })), Layer.orDie);

/**
 * The actor's orders repository over {@link ActorSqliteTest}'s client and the actor's own
 * `syncTransaction`, which runs unchanged under Node.
 */
export const testOrderRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return makeOrderRepository(sql, syncTransaction(sql));
});

/** One Admin call {@link testShopifyAdmin} served. */
export interface AdminCall {
  readonly shop: ShopKey;
  readonly query: string;
  readonly variables: Record<string, unknown> | undefined;
}

/**
 * {@link ShopifyAdmin} answering each call with the next of `replies` (the GraphQL `data`, or a
 * failure), recording it in `calls`. A call past the last reply is a defect, so a test that
 * expects no Admin call passes none.
 */
export const testShopifyAdmin = (
  replies: Array<Effect.Effect<unknown, ShopifyAdminError>>,
  calls: Array<AdminCall>,
) => {
  const graphql = (
    shop: ShopKey,
    query: string,
    options?: { readonly variables?: Record<string, unknown> | undefined },
  ) =>
    Effect.suspend(() => {
      calls.push({ shop, query, variables: options?.variables });
      return replies.shift() ?? Effect.die(new Error("testShopifyAdmin: unscripted call"));
    });
  return Layer.succeed(ShopifyAdmin, {
    graphql: (shop, query, options) =>
      Effect.map(graphql(shop, query, options), (data) => ({ data })),
    graphqlDecode: (shop, schema, query, options) =>
      Effect.flatMap(graphql(shop, query, options), (data) =>
        Schema.decodeUnknownEffect(schema)(data).pipe(Effect.orDie),
      ),
  });
};

/** The order calls {@link testOrderActors} recorded. */
export interface OrderActorCalls {
  readonly versions: Array<{
    readonly key: ShopKey;
    readonly orderId: string;
    readonly updatedAt: number | null;
  }>;
  readonly stored: Array<{
    readonly key: ShopKey;
    readonly order: OrderNode;
    readonly lineItems: ReadonlyArray<LineItemNode>;
  }>;
}

/**
 * `ShopActors.layerTest` whose `orderVersion` answers `version` and whose `storeOrder` writes a
 * fresh, changed row, each recorded in `calls`.
 */
export const testOrderActors = (
  calls: OrderActorCalls,
  version: "stale" | "fetch" | "refused" = "fetch",
) =>
  Layer.effect(
    ShopActors,
    Effect.gen(function* () {
      const base = yield* ShopActors;
      return {
        ...base,
        orderVersion: (key, { orderId, updatedAt }) =>
          Effect.sync(() => {
            calls.versions.push({ key, orderId, updatedAt });
            return version;
          }),
        storeOrder: (key, { order, lineItems }) =>
          Effect.sync(() => {
            calls.stored.push({ key, order, lineItems });
            return { written: true, fresh: true, changed: true, refused: false };
          }),
      };
    }),
  ).pipe(Layer.provide(ShopActors.layerTest([])));
