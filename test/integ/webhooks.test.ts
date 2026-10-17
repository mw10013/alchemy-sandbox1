import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { SEED_SHOP } from "../seed-shops.ts";
import { signWebhook } from "../shopify-webhook.ts";
import { dev } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * Shopify's webhooks against the real Backend and D1: the `/webhooks/` branch checks the HMAC
 * over the bytes sent, and `app/scopes_update` rewrites the seeded session's scope.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("webhooks"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** POSTs `payload` to `path` on the Backend, signed unless `signed` is false; the status. */
const deliver = (
  backendUrl: string,
  path: string,
  topic: string,
  payload: unknown,
  signed = true,
) =>
  Effect.gen(function* () {
    const body = JSON.stringify(payload);
    const headers = yield* signWebhook(topic, SEED_SHOP, body);
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${backendUrl}${path}`).pipe(
        HttpClientRequest.setHeaders(
          signed ? headers : { ...headers, "x-shopify-hmac-sha256": "unsigned" },
        ),
        HttpClientRequest.bodyText(body, "application/json"),
      ),
    );
    return response.status;
  }).pipe(Effect.provide(FetchHttpClient.layer));

test(
  "a signed compliance webhook answers 200 and an unsigned one 401",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const payload = { shop_id: 1, shop_domain: SEED_SHOP };
    assert.strictEqual(
      yield* deliver(backendUrl, "/webhooks/compliance", "shop/redact", payload),
      200,
    );
    assert.strictEqual(
      yield* deliver(backendUrl, "/webhooks/compliance", "shop/redact", payload, false),
      401,
    );
  }),
);

test(
  "app/scopes_update updates the stored scope from the payload",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const status = yield* deliver(backendUrl, "/webhooks/app/scopes_update", "app/scopes_update", {
      current: ["read_orders", "read_products", "write_products"],
    });
    assert.strictEqual(status, 200);
    const session = yield* dev(backendUrl, (c) => c.GetShopSession({ shop: SEED_SHOP }));
    assert.strictEqual(session?.scope, "read_orders,read_products,write_products");
  }),
);
