import { assert, describe, it } from "@effect/vitest";
import { abstractFetch } from "@shopify/shopify-api/runtime";
import * as Effect from "effect/Effect";
import { FAKE_SHOP_GID, ShopifyFake } from "../../integ/shopify-fake.ts";

const TOKEN_URL = "https://a-shop.myshopify.com/admin/oauth/access_token";
const GRAPHQL_URL = "https://a-shop.myshopify.com/admin/api/2026-10/graphql.json";
const refreshGrant = (token: string) => ({
  method: "POST",
  body: JSON.stringify({ grant_type: "refresh_token", refresh_token: token }),
});

const call = (url: string, init?: RequestInit) =>
  Effect.promise(() => Promise.resolve(abstractFetch(url, init)) as Promise<Response>);

describe("ShopifyFake", () => {
  it.effect("answers defaults, and labels the refresh token it saw instead of echoing it", () =>
    Effect.gen(function* () {
      const fake = yield* ShopifyFake;
      yield* fake.script([]);
      const token = yield* call(TOKEN_URL, refreshGrant("shprt_secret_value"));
      assert.strictEqual(token.status, 200);
      yield* call(TOKEN_URL, refreshGrant("shprt_secret_value"));
      yield* call(TOKEN_URL, refreshGrant("shprt_other"));
      const graphql = yield* call(GRAPHQL_URL, { method: "POST", body: "{}" });
      assert.deepStrictEqual(yield* Effect.promise(() => graphql.json()), {
        data: { shop: { id: FAKE_SHOP_GID } },
      });
      const calls = yield* fake.takeCalls;
      assert.deepStrictEqual(calls, [
        { route: "token", grantType: "refresh_token", refreshToken: "refresh-1" },
        { route: "token", grantType: "refresh_token", refreshToken: "refresh-1" },
        { route: "token", grantType: "refresh_token", refreshToken: "refresh-2" },
        { route: "graphql" },
      ]);
      assert.notInclude(JSON.stringify(calls), "shprt_secret_value");
      assert.deepStrictEqual(yield* fake.takeCalls, []);
    }).pipe(Effect.provide(ShopifyFake.layer)),
  );

  it.effect("serves scripted replies per route in order, and a new script replaces the old", () =>
    Effect.gen(function* () {
      const fake = yield* ShopifyFake;
      yield* fake.script([
        { route: "token", status: 503, body: { error: "down" } },
        { route: "graphql", status: 401, body: {} },
      ]);
      assert.strictEqual((yield* call(TOKEN_URL, refreshGrant("a"))).status, 503);
      assert.strictEqual((yield* call(TOKEN_URL, refreshGrant("a"))).status, 200);
      yield* fake.script([{ route: "token", status: 401, body: {} }]);
      assert.strictEqual((yield* call(GRAPHQL_URL, { method: "POST", body: "{}" })).status, 200);
      assert.strictEqual((yield* call(TOKEN_URL, refreshGrant("a"))).status, 401);
    }).pipe(Effect.provide(ShopifyFake.layer)),
  );

  it.effect("answers 599 to anything it does not serve", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* call("https://example.com/admin/oauth/access_token")).status, 599);
      assert.strictEqual(
        (yield* call("https://a-shop.myshopify.com/admin/other.json")).status,
        599,
      );
    }).pipe(Effect.provide(ShopifyFake.layer)),
  );
});
