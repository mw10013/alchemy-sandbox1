import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ShopKey } from "../contract/shop.ts";
import { AuthDb } from "./resources.ts";

/**
 * A `ShopSession` row: Baton's `ShopSession`, one shop's offline Admin API session. Times are
 * epoch ms. `shopAgentId` names the shop's actor; here it is the shop domain, because the actor
 * is addressed by name (`ShopActors.getByName(shop)`), where Baton stored the Agents SDK's id.
 * The three plan columns are a cache that only a plan check writes.
 */
export const ShopSessionRow = Schema.Struct({
  shop: ShopKey,
  shopGid: Schema.String,
  shopAgentId: Schema.String,
  scope: Schema.NullOr(Schema.String),
  accessTokenExpiresAt: Schema.NullOr(Schema.Number),
  accessToken: Schema.NullOr(Schema.String),
  refreshToken: Schema.NullOr(Schema.String),
  refreshTokenExpiresAt: Schema.NullOr(Schema.Number),
  planHandle: Schema.NullOr(Schema.String),
  planHandleExpiresAt: Schema.NullOr(Schema.Number),
  planBoundaryAt: Schema.NullOr(Schema.Number),
});
export type ShopSessionRow = typeof ShopSessionRow.Type;

/**
 * A row as authentication knows it: everything but the plan columns, so re-authenticating never
 * disturbs a cached plan, and a fresh insert leaves them null, which reads as never fetched.
 */
export const ShopSessionUpsert = Schema.Struct(
  Struct.omit(ShopSessionRow.fields, ["planHandle", "planHandleExpiresAt", "planBoundaryAt"]),
);
export type ShopSessionUpsert = typeof ShopSessionUpsert.Type;

/** The token columns {@link ShopSessions}' `updateTokens` rewrites, by shop. */
export type ShopSessionTokens = Pick<
  ShopSessionRow,
  "shop" | "accessToken" | "accessTokenExpiresAt" | "refreshToken" | "refreshTokenExpiresAt"
>;

/** Rows of the `ShopSession` table. A row that does not decode is a broken invariant, so it dies. */
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ShopSessionRow));

const make = Effect.gen(function* () {
  const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);
  const sql = yield* SQL.D1(d1);

  const find = Effect.fn("ShopSessions.find")(function* (shop: ShopKey) {
    const [row] = yield* decodeRows(yield* sql`SELECT * FROM ShopSession WHERE shop = ${shop}`);
    return Option.fromUndefinedOr(row);
  }, Effect.orDie);

  /**
   * Baton's `upsertShopSession`. The conflict branch leaves `shopAgentId` out of the `SET` list:
   * it never changes after insert, and SQLite rewrites an index for every column named in `SET`,
   * whether its value changed or not, so naming it would rewrite its unique index on every
   * re-exchange, which D1 bills as a written row.
   */
  const upsert = Effect.fn("ShopSessions.upsert")(function* (row: ShopSessionUpsert) {
    yield* sql`INSERT INTO ShopSession (shop, shopGid, shopAgentId, scope, accessTokenExpiresAt, accessToken, refreshToken, refreshTokenExpiresAt)
      VALUES (${row.shop}, ${row.shopGid}, ${row.shopAgentId}, ${row.scope}, ${row.accessTokenExpiresAt}, ${row.accessToken}, ${row.refreshToken}, ${row.refreshTokenExpiresAt})
      ON CONFLICT (shop) DO UPDATE SET
        shopGid = excluded.shopGid,
        scope = excluded.scope,
        accessTokenExpiresAt = excluded.accessTokenExpiresAt,
        accessToken = excluded.accessToken,
        refreshToken = excluded.refreshToken,
        refreshTokenExpiresAt = excluded.refreshTokenExpiresAt`;
  }, Effect.orDie);

  const clearAccessToken = Effect.fn("ShopSessions.clearAccessToken")(function* (shop: ShopKey) {
    yield* sql`UPDATE ShopSession SET accessToken = NULL WHERE shop = ${shop}`;
  }, Effect.orDie);

  const updateTokens = Effect.fn("ShopSessions.updateTokens")(function* (
    tokens: ShopSessionTokens,
  ) {
    yield* sql`UPDATE ShopSession SET
        accessToken = ${tokens.accessToken},
        accessTokenExpiresAt = ${tokens.accessTokenExpiresAt},
        refreshToken = ${tokens.refreshToken},
        refreshTokenExpiresAt = ${tokens.refreshTokenExpiresAt}
      WHERE shop = ${tokens.shop}`;
  }, Effect.orDie);

  const updateScope = Effect.fn("ShopSessions.updateScope")(function* (
    shop: ShopKey,
    scope: string | null,
  ) {
    yield* sql`UPDATE ShopSession SET scope = ${scope} WHERE shop = ${shop}`;
  }, Effect.orDie);

  const remove = Effect.fn("ShopSessions.remove")(function* (shop: ShopKey) {
    yield* sql`DELETE FROM ShopSession WHERE shop = ${shop}`;
  }, Effect.orDie);

  return { find, upsert, clearAccessToken, updateTokens, updateScope, remove };
});

/**
 * Baton's `ShopSession` repository: one offline Admin API session per installed shop, written by
 * token exchange. The layer is built once at Worker init, as `Members`' is.
 */
export class ShopSessions extends Context.Service<ShopSessions, Effect.Success<typeof make>>()(
  "app/ShopSessions",
) {
  static readonly layer = Layer.effect(ShopSessions, make);

  /** `ShopSession` rows in memory, for tests. Every write edits the layer's own copy. */
  static readonly layerTest = (seed: ReadonlyArray<ShopSessionRow>) =>
    Layer.sync(ShopSessions, () => {
      const rows = new Map(seed.map((row) => [row.shop, row]));
      const edit = (shop: ShopKey, change: Partial<ShopSessionRow>) =>
        Effect.sync(() => {
          const row = rows.get(shop);
          if (row !== undefined) rows.set(shop, { ...row, ...change });
        });
      return {
        find: (shop: ShopKey) => Effect.sync(() => Option.fromUndefinedOr(rows.get(shop))),
        upsert: (row: ShopSessionUpsert) =>
          Effect.sync(() => {
            const existing = rows.get(row.shop);
            rows.set(
              row.shop,
              existing === undefined
                ? { ...row, planHandle: null, planHandleExpiresAt: null, planBoundaryAt: null }
                : { ...existing, ...row, shopAgentId: existing.shopAgentId },
            );
          }),
        clearAccessToken: (shop: ShopKey) => edit(shop, { accessToken: null }),
        updateTokens: ({ shop, ...tokens }: ShopSessionTokens) => edit(shop, tokens),
        updateScope: (shop: ShopKey, scope: string | null) => edit(shop, { scope }),
        remove: (shop: ShopKey) =>
          Effect.sync(() => {
            rows.delete(shop);
          }),
      };
    });
}
