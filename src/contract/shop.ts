import * as Schema from "effect/Schema";

/**
 * A shop, named by its myshopify domain: Baton's `Shop`, the key of a `ShopSession` row and the
 * name of the shop's actor. Baton's `Shop` is any non-empty string, because it only ever holds
 * what Shopify sent. Here the key also arrives in a URL path, which the route param and the
 * Backend path decode through this before it reaches a query or `getByName`, so it is held to
 * the shape of a myshopify domain.
 */
export const ShopKey = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/u),
).pipe(Schema.brand("ShopKey"));
export type ShopKey = typeof ShopKey.Type;

/** The sandbox's own shop. The member navigation links to it. */
export const SANDBOX_SHOP: ShopKey = Schema.decodeUnknownSync(ShopKey)(
  "alchemy-sandbox1.myshopify.com",
);

/**
 * `shopSnapshot`'s input, shared by both sides of the binding; see `ShoutInput`. `sessionToken`
 * is a merchant's Shopify session token; its absence makes the caller a member.
 */
export const ShopSnapshotInput = Schema.Struct({
  key: ShopKey,
  sessionToken: Schema.optional(Schema.String),
});
export type ShopSnapshotInput = typeof ShopSnapshotInput.Type;

/**
 * The caller is signed in, or holds a valid Shopify token, but may not open this shop: an
 * operator, someone with no `Member` row for it, or a token for another shop.
 */
export class NotAShopMember extends Schema.TaggedError<NotAShopMember>()("NotAShopMember", {}) {}
