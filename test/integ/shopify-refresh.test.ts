import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../src/contract/shop.ts";
import { dev, integ } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import type { ShopifyFakeReply } from "./rpcs.ts";
import Stack from "./stack.ts";

/**
 * The offline-token refresh over real SQL and the fake Shopify HTTP layer: `ExpireShopSession`
 * ages the seeded session, `PingAdmin` makes the Backend's own Admin call, `ScriptShopify` shapes
 * Shopify's answers and `ShopifyCalls` shows what it was asked.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("shopifyrefresh"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const shop = Schema.decodeUnknownSync(ShopKey)("seed-shop.myshopify.com");
const otherShop = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");

const HOUR = 60 * 60 * 1000;
const NINETY_DAYS = 90 * 24 * HOUR;
const FAKE_SHOP_GID = "gid://shopify/Shop/0";

/** Resets the fake, then ages the shop's session with its refresh token kept. */
const expiredAndScripted = (backendUrl: string, replies: ReadonlyArray<ShopifyFakeReply>) =>
  Effect.gen(function* () {
    yield* integ(backendUrl, (c) => c.ScriptShopify({ replies }));
    yield* dev(backendUrl, (c) => c.ExpireShopSession({ shop, refreshToken: "keep" }));
  });

const ping = (backendUrl: string) => dev(backendUrl, (c) => c.PingAdmin({ shop }));

/** The calls the fake served since the last script or read. */
const shopifyCalls = (backendUrl: string) => integ(backendUrl, (c) => c.ShopifyCalls({}));

const session = (backendUrl: string, of = shop) =>
  dev(backendUrl, (c) => c.GetShopSession({ shop: of })).pipe(
    Effect.map((found) => {
      assert.isNotNull(found);
      return found;
    }),
  );

test(
  "an expired token refreshes: new expiries, no lease, one grant and one Admin call",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* expiredAndScripted(backendUrl, []);
    assert.deepStrictEqual(yield* ping(backendUrl), { ok: FAKE_SHOP_GID });
    const now = Date.now();
    const after = yield* session(backendUrl);
    assert.approximately(after.accessTokenExpiresAt ?? 0, now + HOUR, 2 * 60 * 1000);
    assert.approximately(after.refreshTokenExpiresAt ?? 0, now + NINETY_DAYS, 2 * 60 * 1000);
    assert.strictEqual(after.refreshLeaseUntil, null);
    const calls = yield* shopifyCalls(backendUrl);
    assert.deepStrictEqual(
      calls.map(({ route }) => route),
      ["token", "graphql"],
    );
    assert.strictEqual(calls[0]?.grantType, "refresh_token");
  }),
);

test(
  "a 401 on the grant with no winner is refresh-token-rejected after the recovery budget",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* expiredAndScripted(backendUrl, [
      { route: "token", status: 401, body: { error: "invalid_request" } },
    ]);
    const before = yield* session(backendUrl);
    const started = Date.now();
    assert.deepStrictEqual(yield* ping(backendUrl), {
      error: "ReauthorizationRequired",
      reason: "refresh-token-rejected",
    });
    assert.isAbove(Date.now() - started, 1500);
    const after = yield* session(backendUrl);
    assert.strictEqual(after.accessTokenExpiresAt, before.accessTokenExpiresAt);
    assert.strictEqual(after.refreshLeaseUntil, null);
  }),
);

test(
  "a 503 on the grant is retried with the same token and then succeeds",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* expiredAndScripted(backendUrl, [
      { route: "token", status: 503, body: { error: "down" } },
    ]);
    assert.deepStrictEqual(yield* ping(backendUrl), { ok: FAKE_SHOP_GID });
    const calls = yield* shopifyCalls(backendUrl);
    const grants = calls.filter(({ route }) => route === "token");
    assert.strictEqual(grants.length, 2);
    assert.strictEqual(grants[0]?.refreshToken, grants[1]?.refreshToken);
  }),
);

test(
  "five concurrent pings refresh exactly once",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* expiredAndScripted(backendUrl, []);
    const answers = yield* Effect.all(
      Array.from({ length: 5 }, () => ping(backendUrl)),
      { concurrency: "unbounded" },
    );
    for (const answer of answers) assert.deepStrictEqual(answer, { ok: FAKE_SHOP_GID });
    const calls = yield* shopifyCalls(backendUrl);
    assert.strictEqual(calls.filter(({ route }) => route === "token").length, 1);
    assert.strictEqual(calls.filter(({ route }) => route === "graphql").length, 5);
    assert.strictEqual((yield* session(backendUrl)).refreshLeaseUntil, null);
  }),
);

test(
  "another shop's session is untouched",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const other = yield* session(backendUrl, otherShop);
    assert.strictEqual(other.accessTokenExpiresAt, 4_102_444_800_000);
    assert.strictEqual(other.refreshTokenExpiresAt, 4_102_444_800_000);
    assert.strictEqual(other.refreshLeaseUntil, null);
  }),
);
