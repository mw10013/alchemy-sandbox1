import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ShopSessions, type ShopSessionRow } from "../../../src/backend/shop-sessions.ts";
import { Shopify } from "../../../src/backend/shopify.ts";
import { Webhooks } from "../../../src/backend/webhooks.ts";
import { SEED_SHOP } from "../../seed-shops.ts";
import { signWebhook } from "../../shopify-webhook.ts";
import { QuietLogs, testShopify } from "./layers.ts";
import appToml from "../../../shopify.app.toml?raw";
import stagingToml from "../../../shopify.app.staging.toml?raw";

const session: ShopSessionRow = {
  shop: SEED_SHOP,
  shopGid: "gid://shopify/Shop/1",
  shopActorId: SEED_SHOP,
  scope: "read_products",
  accessTokenExpiresAt: 1_900_000_000_000,
  accessToken: "shpat_secret_access",
  refreshToken: "shprt_secret_refresh",
  refreshTokenExpiresAt: 1_900_000_000_000,
  refreshLeaseUntil: null,
  planHandle: null,
  planHandleExpiresAt: null,
  planBoundaryAt: null,
};

/** {@link Webhooks} over {@link testShopify} holding `rows`, which stays readable. */
const layer = (rows: ReadonlyArray<ShopSessionRow> = [session]) =>
  Webhooks.layer.pipe(Layer.provideMerge(testShopify(rows)), Layer.provideMerge(QuietLogs));

/**
 * A delivery of `payload` for `topic` (the header's form), signed by {@link signWebhook}.
 * `headers` overrides or, with `null`, drops one of the signed headers.
 */
const webhookRequest = ({
  topic,
  payload = {},
  method = "POST",
  headers = {},
}: {
  topic: string;
  payload?: unknown;
  method?: string;
  headers?: Record<string, string | null>;
}) =>
  Effect.gen(function* () {
    const body = JSON.stringify(payload);
    const signed = new Headers(yield* signWebhook(topic, SEED_SHOP, body));
    for (const [name, value] of Object.entries(headers))
      if (value === null) signed.delete(name);
      else signed.set(name, value);
    return new Request("https://example.com/webhooks/compliance", {
      method,
      headers: signed,
      body: method === "POST" ? body : undefined,
    });
  });

/** The Backend's `/webhooks/` branch answering `request`. */
const serve = (request: Request) =>
  Effect.gen(function* () {
    const webhooks = yield* Webhooks;
    return yield* webhooks.serve(HttpServerRequest.fromWeb(request));
  });

const storedScope = Effect.gen(function* () {
  const shopSessions = yield* ShopSessions;
  return Option.map(yield* shopSessions.find(SEED_SHOP), (row) => row.scope);
});

describe("Shopify.validateWebhook", () => {
  it.effect("returns shop, topic, and parsed payload for a valid webhook", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        payload: { id: 1, domain: SEED_SHOP },
      });
      const result = yield* shopify.validateWebhook(request);
      assert.strictEqual(result.shop, SEED_SHOP);
      assert.strictEqual(result.topic, "APP_UNINSTALLED");
      assert.deepStrictEqual(result.payload, { id: 1, domain: SEED_SHOP });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("fails with a 401 ResponseError for an invalid HMAC", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        headers: { "x-shopify-hmac-sha256": "not-a-valid-hmac" },
      });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WebhookRejected");
      assert.strictEqual(error.status, 401);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("fails with a 405 ResponseError for a non-POST request", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({ topic: "app/uninstalled", method: "GET" });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assert.strictEqual(error.status, 405);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("fails with a 400 ResponseError when required webhook headers are missing", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        headers: { "x-shopify-topic": null },
      });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assert.strictEqual(error.status, 400);
    }).pipe(Effect.provide(layer())),
  );

  it.effect.each([
    "x-shopify-hmac-sha256",
    "x-shopify-shop-domain",
    "x-shopify-api-version",
    "x-shopify-webhook-id",
  ])("a delivery without %s is 400", (header) =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        headers: { [header]: null },
      });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assert.strictEqual(error.status, 400);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a signed shop domain that is not a ShopKey is 400", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        headers: { "x-shopify-shop-domain": "example.com" },
      });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assert.strictEqual(error.status, 400);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("succeeds for a shop with no stored offline session", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/scopes_update",
        payload: { current: ["read_products"] },
      });
      const result = yield* shopify.validateWebhook(request);
      assert.strictEqual(result.topic, "APP_SCOPES_UPDATE");
      assert.isTrue(Option.isNone(yield* storedScope));
    }).pipe(Effect.provide(layer([]))),
  );
});

describe("handleWebhook", () => {
  it.effect("fails with the rejection ResponseError without running the handler", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        headers: { "x-shopify-hmac-sha256": "not-a-valid-hmac" },
      });
      const error = yield* webhooks
        .handle(request, () => Effect.die("handler must not run for a rejected webhook"))
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "WebhookRejected");
      assert.strictEqual(error.status, 401);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("runs the handler with the validated result and returns its Response", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks;
      const request = yield* webhookRequest({ topic: "app/uninstalled", payload: { id: 1 } });
      const response = yield* webhooks.handle(request, (r) =>
        Effect.succeed(
          HttpServerResponse.empty({
            status: 202,
            headers: { "x-shop": r.shop, "x-topic": r.topic },
          }),
        ),
      );
      assert.strictEqual(response.status, 202);
      assert.strictEqual(response.headers["x-shop"], SEED_SHOP);
      assert.strictEqual(response.headers["x-topic"], "APP_UNINSTALLED");
    }).pipe(Effect.provide(layer())),
  );

  it.effect("re-raises a handler failure so Shopify retries", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks;
      const request = yield* webhookRequest({ topic: "app/uninstalled", payload: { id: 1 } });
      const error = yield* webhooks
        .handle(request, () => Effect.fail(new Error("boom")))
        .pipe(Effect.flip);
      assert.instanceOf(error, Error);
      assert.strictEqual(error.message, "boom");
    }).pipe(Effect.provide(layer())),
  );
});

describe("Webhooks.serve", () => {
  it.effect.each([
    { topic: "customers/data_request", payload: { customer: { id: 1 }, data_request: { id: 1 } } },
    { topic: "customers/redact", payload: { customer: { id: 1 } } },
    { topic: "shop/redact", payload: { shop_id: 1, shop_domain: SEED_SHOP } },
  ])("$topic validates and answers 200", ({ topic, payload }) =>
    Effect.gen(function* () {
      const response = yield* serve(yield* webhookRequest({ topic, payload }));
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* storedScope, Option.some("read_products"));
    }).pipe(Effect.provide(layer())),
  );

  it.effect("app/scopes_update updates the stored scope from the payload", () =>
    Effect.gen(function* () {
      const response = yield* serve(
        yield* webhookRequest({
          topic: "app/scopes_update",
          payload: { current: ["read_products", "write_products"] },
        }),
      );
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* storedScope, Option.some("read_products,write_products"));
    }).pipe(Effect.provide(layer())),
  );

  it.effect("app/scopes_update is a no-op when no session row exists", () =>
    Effect.gen(function* () {
      const response = yield* serve(
        yield* webhookRequest({
          topic: "app/scopes_update",
          payload: { current: ["read_products"] },
        }),
      );
      assert.strictEqual(response.status, 200);
      assert.isTrue(Option.isNone(yield* storedScope));
    }).pipe(Effect.provide(layer([]))),
  );

  it.effect("an app/scopes_update payload without current answers 500 and writes nothing", () =>
    Effect.gen(function* () {
      const response = yield* serve(
        yield* webhookRequest({ topic: "app/scopes_update", payload: { previous: [] } }),
      );
      assert.strictEqual(response.status, 500);
      assert.deepStrictEqual(yield* storedScope, Option.some("read_products"));
    }).pipe(Effect.provide(layer())),
  );

  it.effect.each(["app/uninstalled", "orders/create", "orders/edited"])(
    "%s answers 200 and acts on nothing yet",
    (topic) =>
      Effect.gen(function* () {
        const response = yield* serve(yield* webhookRequest({ topic, payload: { id: 1 } }));
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(yield* storedScope, Option.some("read_products"));
      }).pipe(Effect.provide(layer())),
  );

  it.effect("a validated topic Baton does not subscribe to answers 404", () =>
    Effect.gen(function* () {
      const response = yield* serve(yield* webhookRequest({ topic: "products/update" }));
      assert.strictEqual(response.status, 404);
    }).pipe(Effect.provide(layer())),
  );

  it.effect.each<{ name: string; status: number; headers: Record<string, string | null> }>([
    { name: "a bad HMAC", status: 401, headers: { "x-shopify-hmac-sha256": "bad" } },
    { name: "a missing topic", status: 400, headers: { "x-shopify-topic": null } },
  ])("$name answers $status", ({ status, headers }) =>
    Effect.gen(function* () {
      const response = yield* serve(yield* webhookRequest({ topic: "shop/redact", headers }));
      assert.strictEqual(response.status, status);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a GET answers 405", () =>
    Effect.gen(function* () {
      const response = yield* serve(yield* webhookRequest({ topic: "shop/redact", method: "GET" }));
      assert.strictEqual(response.status, 405);
    }).pipe(Effect.provide(layer())),
  );
});

/** Each `[[webhooks.subscriptions]]` block of `toml` whose `uri` is `uri`. */
const tomlBlocks = (toml: string, uri: string) =>
  toml.split("[[webhooks.subscriptions]]").filter((section) => section.includes(`uri = "${uri}"`));

const ORDER_INCLUDE_FIELDS = 'include_fields = ["id", "admin_graphql_api_id", "updated_at"]';

for (const [name, toml] of [
  ["shopify.app.toml", appToml],
  ["shopify.app.staging.toml", stagingToml],
] as const)
  describe(name, () => {
    /**
     * Baton reads orders and never writes them, so `read_orders` is the whole of its order
     * access. Read from the toml so widening it is a conscious edit here too: a scope Baton
     * cannot justify is a scope a merchant is asked to grant for nothing.
     */
    it("requests read_orders and read_products only", () => {
      const scopes = /scopes = "(?<scopes>[^"]*)"/u.exec(toml)?.groups?.scopes;
      assert.deepStrictEqual(scopes?.split(","), ["read_orders", "read_products"]);
    });

    /**
     * `orders/updated` is not subscribed: it fires on every save of the order, and every change
     * Baton acts on has its own topic. Read from the toml so re-adding one is a conscious edit
     * here too.
     */
    it("subscribes to create, paid, edited, cancelled, and fulfilled only", () => {
      const topics = tomlBlocks(toml, "/webhooks/orders").flatMap((block) =>
        [...block.matchAll(/"(?<topic>orders\/[a-z_]+)"/gu)].map((match) => match.groups?.topic),
      );
      assert.deepStrictEqual(
        topics.toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
        ["orders/cancelled", "orders/create", "orders/edited", "orders/fulfilled", "orders/paid"],
      );
    });

    /**
     * Shopify drops a delivery whose trimmed payload is identical to the last one, so the
     * trimmed topics must carry `updated_at`. `orders/edited` carries no `include_fields`: its
     * payload is the edit, which differs every time.
     */
    it("trims every orders topic but orders/edited to id, admin_graphql_api_id and updated_at", () => {
      const blocks = tomlBlocks(toml, "/webhooks/orders");
      const edited = blocks.filter((block) => block.includes('"orders/edited"'));
      const trimmed = blocks.filter((block) => !block.includes('"orders/edited"'));
      assert.lengthOf(edited, 1);
      assert.notInclude(edited[0] ?? "", "include_fields =");
      assert.isNotEmpty(trimmed);
      for (const block of trimmed) assert.include(block, ORDER_INCLUDE_FIELDS);
    });
  });
