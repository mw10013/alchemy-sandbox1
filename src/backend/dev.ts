import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Email } from "../contract/auth.ts";
import { DevRpcs, type PingAdminAnswer, type ShopSessionView } from "../contract/dev.ts";
import type { ShopKey } from "../contract/shop.ts";
import { Fixtures } from "./fixture.ts";
import { Members } from "./members.ts";
import { ShopActors } from "./shop-actors.ts";
import { ShopSessions } from "./shop-sessions.ts";
import { SHOP_GID_QUERY, ShopGidResponse } from "./shopify.ts";
import { ShopifyAdmin, type ShopifyAdminError } from "./shopify-admin.ts";

const devProcedures = Effect.gen(function* () {
  const members = yield* Members;
  const actors = yield* ShopActors;
  const sessions = yield* ShopSessions;
  const admin = yield* ShopifyAdmin;

  const removeMember = Effect.fn("Dev.removeMember")(function* (shop: ShopKey, email: Email) {
    const removed = yield* members.remove(shop, email);
    if (Option.isNone(removed)) return { removed: false, closed: 0 };
    // Baton's rule on `Members`: the edit is followed by a revoke on the shop's actor. A failed
    // revoke is logged and answers `closed: 0`, which a test sees.
    const { closed } = yield* actors.revoke(shop, "member", removed.value);
    return { removed: true, closed };
  });

  const getShopSession = Effect.fn("Dev.getShopSession")(function* (shop: ShopKey) {
    return Option.match(yield* sessions.find(shop), {
      onNone: () => null,
      onSome: ({
        shopGid,
        scope,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        refreshLeaseUntil,
      }): ShopSessionView => ({
        shopGid,
        scope,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        refreshLeaseUntil,
      }),
    });
  });

  const expireShopSession = Effect.fn("Dev.expireShopSession")(function* (
    shop: ShopKey,
    refreshToken: "keep" | "invalidate",
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* sessions.expireAccessToken(
      shop,
      now - 1000,
      refreshToken === "invalidate" ? `shprt_invalid_${crypto.randomUUID()}` : undefined,
    );
    return {};
  });

  const pingAdmin = (shop: ShopKey): Effect.Effect<PingAdminAnswer> =>
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
    );

  return { removeMember, getShopSession, expireShopSession, pingAdmin };
});

export const DevHandlers = DevRpcs.toLayer(
  Effect.gen(function* () {
    const fixtures = yield* Fixtures;
    const dev = yield* devProcedures;
    return DevRpcs.of({
      LoadFixture: ({ shop, fixture }) => fixtures.load(shop, fixture),
      AddToFixture: ({ shop, fixture }) => fixtures.add(shop, fixture),
      RemoveMember: ({ shop, email }) => dev.removeMember(shop, email),
      GetShopSession: ({ shop }) => dev.getShopSession(shop),
      ExpireShopSession: ({ shop, refreshToken }) => dev.expireShopSession(shop, refreshToken),
      PingAdmin: ({ shop }) => dev.pingAdmin(shop),
    });
  }),
);
