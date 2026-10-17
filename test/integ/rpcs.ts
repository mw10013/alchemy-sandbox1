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
);

export const IntegHandlers = IntegRpcs.toLayer(
  Effect.gen(function* () {
    const { auth, maySignIn } = yield* Auth;
    const delivery = yield* MagicLinkDelivery;
    const shopifyFake = yield* ShopifyFake;

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
    });
  }),
);
