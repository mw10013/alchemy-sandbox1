import * as Schema from "effect/Schema";

/**
 * A shop, named by its myshopify domain: Baton's `Shop`, the key of a `ShopSession` row and the
 * name of the shop's actor. Baton's `Shop` is any non-empty string, because it only ever holds
 * what Shopify sent. Here the key also arrives in a URL path, which the route param and the
 * Backend path decode through this before it reaches a query or `getByName`, so it is held to
 * the shape of a myshopify domain.
 *
 * A module of its own: `api/backend.ts` needs it, and `api/shop-actor.ts` imports from
 * `api/backend.ts`, so it cannot live in either without an import cycle.
 */
export const ShopKey = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/u),
).pipe(Schema.brand("ShopKey"));
export type ShopKey = typeof ShopKey.Type;

/** The sandbox's own shop. The member navigation links to it. */
export const SANDBOX_SHOP: ShopKey = Schema.decodeUnknownSync(ShopKey)(
  "alchemy-sandbox1.myshopify.com",
);
