/**
 * What only integ may do, served by the test Backend on `/api/integ`: the contract and its
 * handlers together, because nothing in `src/` may import either.
 *
 * @module
 */
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import { Email, ReturnPath } from "../../src/contract/auth.ts";
import { Auth } from "../../src/backend/auth.ts";
import { MagicLinkDelivery } from "../../src/backend/magic-link-delivery.ts";
import { Members } from "../../src/backend/members.ts";
import { ShopKey } from "../../src/contract/shop.ts";
import { OrdersListInput, OrdersListPage } from "../../src/contract/shop-actor.ts";
import { OrderDetail } from "../../src/domain/orders.ts";
import { LineItemNode, OrderNode } from "../../src/backend/order-sync.ts";
import { ShopActors } from "../../src/backend/shop-actors.ts";
import { ShopifyFake } from "./shopify-fake.ts";

/** One scripted answer of the fake Shopify HTTP layer: which endpoint it answers, and how. */
export const ShopifyFakeReply = Schema.Struct({
  route: Schema.Literals(["token", "graphql"]),
  status: Schema.Int,
  body: Schema.Unknown,
});
export type ShopifyFakeReply = typeof ShopifyFakeReply.Type;

/**
 * One call the fake Shopify HTTP layer served. `refreshToken` is a stable label for the refresh
 * token a `refresh_token` grant presented (`refresh-1` for the first distinct token it saw), never
 * the token, so the same label twice means a retry with the same token.
 */
export const ShopifyFakeCall = Schema.Struct({
  route: Schema.Literals(["token", "graphql"]),
  grantType: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
});
export type ShopifyFakeCall = typeof ShopifyFakeCall.Type;

/**
 * The integ procedures.
 *
 * - `IssueMagicLink` is `BackendApi.requestMagicLink` without the rate limit or the non-member
 *   silence, handing the link back, because integ has no page to read it from; an address that
 *   could not sign in, or a stage that mails its links, is a defect.
 * - `ScriptShopify` replaces {@link ShopifyFake}'s queued replies (a reply per call to its token
 *   or GraphQL endpoint, in order; an empty queue answers with defaults) and clears its call log;
 *   `ShopifyCalls` answers the calls it served since, as {@link ShopifyFakeCall}, and clears them.
 * - `OrderVersion`, `StoreOrder`, `GetOrder` and `ListOrders` are the {@link ShopActors} methods
 *   of the same names on `shop`'s actor, as the Backend calls them.
 * - `ShopIdentityNames` answers the emails of `shop`'s `Member` rows and the names of its `Team`
 *   rows, read from D1 alone ({@link Members}' `identityNames`), so it never reaches the actor.
 */
export const IntegRpcs = RpcGroup.make(
  Rpc.make("IssueMagicLink", {
    payload: { email: Email, returnTo: Schema.optional(ReturnPath) },
    success: Schema.Struct({ link: Schema.String }),
  }),
  Rpc.make("ScriptShopify", {
    payload: { replies: Schema.Array(ShopifyFakeReply) },
    success: Schema.Struct({}),
  }),
  Rpc.make("ShopifyCalls", {
    payload: {},
    success: Schema.Array(ShopifyFakeCall),
  }),
  Rpc.make("OrderVersion", {
    payload: { shop: ShopKey, orderId: Schema.String, updatedAt: Schema.NullOr(Schema.Number) },
    success: Schema.Literals(["stale", "fetch", "refused"]),
  }),
  Rpc.make("StoreOrder", {
    payload: { shop: ShopKey, order: OrderNode, lineItems: Schema.Array(LineItemNode) },
    success: Schema.Struct({
      written: Schema.Boolean,
      fresh: Schema.Boolean,
      changed: Schema.Boolean,
      refused: Schema.Boolean,
    }),
  }),
  Rpc.make("GetOrder", {
    payload: { shop: ShopKey, orderId: Schema.String },
    success: Schema.NullOr(OrderDetail),
  }),
  Rpc.make("ListOrders", {
    payload: { shop: ShopKey, ...OrdersListInput.fields },
    success: OrdersListPage,
  }),
  Rpc.make("ShopIdentityNames", {
    payload: { shop: ShopKey },
    success: Schema.Struct({ emails: Schema.Array(Email), teams: Schema.Array(Schema.String) }),
  }),
);

export const IntegHandlers = IntegRpcs.toLayer(
  Effect.gen(function* () {
    const { auth, maySignIn } = yield* Auth;
    const delivery = yield* MagicLinkDelivery;
    const shopifyFake = yield* ShopifyFake;
    const actors = yield* ShopActors;
    const members = yield* Members;

    return IntegRpcs.of({
      IssueMagicLink: ({ email, returnTo }, { headers }) =>
        Effect.gen(function* () {
          if (!(yield* maySignIn(email)))
            return yield* Effect.die(new Error(`${email} is neither a user nor a member`));
          yield* auth.api
            .signInMagicLink({
              body: { email, callbackURL: returnTo ?? "/shop", errorCallbackURL: "/sign-in" },
              headers: new Headers(headers),
            })
            .pipe(Effect.orDie);
          const link = yield* delivery.take(email);
          if (Option.isNone(link))
            return yield* Effect.die(new Error(`no link for ${email}: the stage mails its links`));
          return { link: link.value };
        }).pipe(Effect.provide(RuntimeContext.phantom)),
      ScriptShopify: ({ replies }) => shopifyFake.script(replies).pipe(Effect.as({})),
      ShopifyCalls: () => shopifyFake.takeCalls,
      OrderVersion: ({ shop, ...input }) => actors.orderVersion(shop, input),
      StoreOrder: ({ shop, ...input }) => actors.storeOrder(shop, input),
      GetOrder: ({ shop, orderId }) => actors.getOrder(shop, orderId),
      ListOrders: ({ shop, ...input }) => actors.listOrders(shop, input),
      ShopIdentityNames: ({ shop }) => members.identityNames(shop),
    });
  }),
);
