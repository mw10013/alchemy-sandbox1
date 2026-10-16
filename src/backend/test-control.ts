import { RuntimeContext } from "alchemy";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ConnectionCaller } from "../contract/shop-actor.ts";
import {
  TestControlAuth,
  TestControlRpcs,
  TestControlUnauthorized,
} from "../contract/test-control.ts";
import { ShopActors } from "./shop-actors.ts";
import { Auth } from "./auth.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { Members } from "./members.ts";
import { ShopSessions } from "./shop-sessions.ts";
import { SHOP_GID_QUERY, ShopGidResponse, Shopify } from "./shopify.ts";
import { ShopifyAdmin, type ShopifyAdminError } from "./shopify-admin.ts";
import { ShopifyFake } from "./shopify-fake.ts";

/** The stage's `E2E_TOKEN`, read once by the Worker, which serves test control only when it has one. */
export class TestControlToken extends Context.Service<TestControlToken, string>()(
  "app/TestControlToken",
) {}

/** Admits a call whose `x-e2e-token` header is {@link TestControlToken}; RPC headers are lowercased. */
export const TestControlAuthLive = Layer.effect(
  TestControlAuth,
  Effect.gen(function* () {
    const token = yield* TestControlToken;
    return TestControlAuth.of((effect, { headers }) =>
      headers["x-e2e-token"] === token ? effect : Effect.fail(new TestControlUnauthorized()),
    );
  }),
);

export const TestControlHandlers = TestControlRpcs.toLayer(
  Effect.gen(function* () {
    const { auth, maySignIn } = yield* Auth;
    const delivery = yield* MagicLinkDelivery;
    const members = yield* Members;
    const actors = yield* ShopActors;
    const shopify = yield* Shopify;
    const sessions = yield* ShopSessions;
    const shopifyFake = yield* ShopifyFake;
    const admin = yield* ShopifyAdmin;

    return TestControlRpcs.of({
      AddMember: ({ shop, email }) => members.add(shop, email),
      RemoveMember: ({ shop, email }) =>
        Effect.gen(function* () {
          const removed = yield* members.remove(shop, email);
          if (Option.isNone(removed)) return { removed: false, closed: 0 };
          // Baton's rule on `Members`: the edit is followed by a revoke on the shop's actor. A
          // failed revoke is logged and answers `closed: 0`, which a test sees.
          const { closed } = yield* actors.revoke(shop, "member", removed.value);
          return { removed: true, closed };
        }),
      IssueMerchantSessionToken: ({ shop, expiresInSeconds }) =>
        shopify
          .signSessionToken({ shop, expiresIn: expiresInSeconds })
          .pipe(Effect.map((token) => ({ token }))),
      GetShopSession: ({ shop }) =>
        sessions.find(shop).pipe(
          Effect.map(
            Option.match({
              onNone: () => null,
              onSome: ({
                shopGid,
                scope,
                accessTokenExpiresAt,
                refreshTokenExpiresAt,
                refreshLeaseUntil,
              }) => ({
                shopGid,
                scope,
                accessTokenExpiresAt,
                refreshTokenExpiresAt,
                refreshLeaseUntil,
              }),
            }),
          ),
        ),
      ExpireAccessToken: ({ shop, refreshToken }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* sessions.expireAccessToken(
            shop,
            now - 1000,
            refreshToken === "invalidate" ? `shprt_invalid_${crypto.randomUUID()}` : undefined,
          );
          return {};
        }),
      PingAdmin: ({ shop }) =>
        admin.graphqlDecode(shop, ShopGidResponse, SHOP_GID_QUERY).pipe(
          Effect.map(({ shop: { id } }) => ({ ok: id })),
          Effect.catch((error: ShopifyAdminError) =>
            Effect.succeed(
              Match.value(error).pipe(
                Match.tags({
                  OfflineSessionMissing: () => ({ error: "OfflineSessionMissing" as const }),
                  ReauthorizationRequired: ({ reason }) => ({
                    error: "ReauthorizationRequired" as const,
                    reason,
                  }),
                  ShopifyUnavailable: () => ({ error: "ShopifyUnavailable" as const }),
                }),
                Match.exhaustive,
              ),
            ),
          ),
        ),
      ScriptShopify: ({ replies }) => shopifyFake.script(replies).pipe(Effect.as({})),
      ShopifyCalls: () => shopifyFake.takeCalls,
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
    });
  }),
);

const decodeTestCaller = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionCaller));

/**
 * The caller a test names for the test-only upgrade route, `/api/test-control/actor/<key>`: the
 * JSON {@link ConnectionCaller} in `x-test-caller`, admitted only with the stage's `E2E_TOKEN`
 * in `x-e2e-token`. The route forwards the upgrade to the actor as that caller, skipping the
 * gate, so a test can open a socket as an identity no sign-in produces, such as an expired
 * session. None for a wrong token or a caller that does not decode; the route is then 404, as
 * it is on a stage without the token. The Website has no route to it.
 */
export const testControlCaller = (
  token: string,
  headers: { readonly [name: string]: string | undefined },
): Option.Option<ConnectionCaller> =>
  headers["x-e2e-token"] === token ? decodeTestCaller(headers["x-test-caller"]) : Option.none();
