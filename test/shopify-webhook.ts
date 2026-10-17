import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ShopKey } from "../src/contract/shop.ts";
import { SHOPIFY_API_SECRET_FAKE } from "../src/backend/shopify.ts";

const encodeBase64 = Schema.encodeSync(Schema.Uint8ArrayFromBase64);
const encoder = new TextEncoder();

/**
 * The headers Shopify sends with a webhook delivery of `body`: the five the Shopify library
 * requires (HMAC, topic, shop domain, API version, webhook id) and `content-type`. The HMAC is
 * Shopify's, base64 HMAC-SHA256 of the exact body under the fake app's secret
 * ({@link SHOPIFY_API_SECRET_FAKE}), which every stage without Shopify CLI binds; a test that
 * proves a refusal drops or overwrites a header. `topic` is the header's form, `app/uninstalled`.
 */
export const signWebhook = Effect.fn("signWebhook")(function* (
  topic: string,
  shop: ShopKey,
  body: string,
) {
  const signature = yield* Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(SHOPIFY_API_SECRET_FAKE),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return crypto.subtle.sign("HMAC", key, encoder.encode(body));
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-shopify-hmac-sha256": encodeBase64(new Uint8Array(signature)),
    "x-shopify-topic": topic,
    "x-shopify-shop-domain": shop,
    "x-shopify-api-version": "2026-10",
    "x-shopify-webhook-id": crypto.randomUUID(),
  };
  return headers;
});
