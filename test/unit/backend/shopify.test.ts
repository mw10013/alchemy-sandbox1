import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { SANDBOX_SHOP } from "../../../src/contract/shop.ts";
import { ShopSessions } from "../../../src/backend/shop-sessions.ts";
import { Shopify } from "../../../src/backend/shopify.ts";

/** The app under test: a fake key and secret; no `ShopSession` row, since nothing exchanges. */
const appWith = (options: { apiKey: string; apiSecret: string }) =>
  Shopify.layerWith({
    apiKey: options.apiKey,
    apiSecret: Redacted.make(options.apiSecret),
    appUrl: "http://localhost",
  }).pipe(Layer.provide(ShopSessions.layerTest([])));

const layer = appWith({ apiKey: "fake-api-key", apiSecret: "fake-api-secret" });

/** A token signed by an app with another key or secret. */
const signedBy = (options: { apiKey: string; apiSecret: string }, expiresIn?: number) =>
  Effect.flatMap(Shopify, (shopify) =>
    shopify.signSessionToken({ shop: SANDBOX_SHOP, expiresIn }),
  ).pipe(Effect.provide(appWith(options)));

describe("Shopify session tokens", () => {
  it.effect("a signed token decodes to its shop", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const token = yield* shopify.signSessionToken({ shop: SANDBOX_SHOP });
      const decoded = yield* shopify.decodeSessionToken(token);
      assert.strictEqual(new URL(decoded.dest).hostname, SANDBOX_SHOP);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([
    { name: "a wrong aud", token: signedBy({ apiKey: "other-key", apiSecret: "fake-api-secret" }) },
    {
      name: "a wrong secret",
      token: signedBy({ apiKey: "fake-api-key", apiSecret: "other-secret" }),
    },
    {
      name: "an expired token",
      token: signedBy({ apiKey: "fake-api-key", apiSecret: "fake-api-secret" }, -10),
    },
    { name: "a malformed token", token: Effect.succeed("not.a-token") },
  ])("$name fails InvalidSessionToken", ({ token }) =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const error = yield* shopify.decodeSessionToken(yield* token).pipe(Effect.flip);
      assert.strictEqual(error._tag, "InvalidSessionToken");
    }).pipe(Effect.provide(layer)),
  );
});
