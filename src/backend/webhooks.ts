import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ShopSessions } from "./shop-sessions.ts";
import { Shopify, type ValidatedWebhook } from "./shopify.ts";

/**
 * The topics Baton answers, in the storage form `Shopify.validateWebhook` hands on. They are
 * the subscriptions of `shopify.app.toml`; a validated delivery of any other topic is 404.
 */
export const WebhookTopic = Schema.Literals([
  "CUSTOMERS_DATA_REQUEST",
  "CUSTOMERS_REDACT",
  "SHOP_REDACT",
  "APP_SCOPES_UPDATE",
  "APP_UNINSTALLED",
  "ORDERS_CREATE",
  "ORDERS_PAID",
  "ORDERS_EDITED",
  "ORDERS_CANCELLED",
  "ORDERS_FULFILLED",
]);
export type WebhookTopic = typeof WebhookTopic.Type;
const decodeTopic = Schema.decodeUnknownOption(WebhookTopic);

/** The `app/scopes_update` payload: the scopes the shop now grants. */
export const ScopesUpdatePayload = Schema.Struct({
  current: Schema.Array(Schema.String),
});
const decodeScopesUpdate = Schema.decodeUnknownEffect(ScopesUpdatePayload);

const ok = HttpServerResponse.empty({ status: 200 });

/**
 * The GDPR/CPRA compliance topics (`customers/data_request`, `customers/redact`, `shop/redact`),
 * required for App Store review and routed to one URI by `compliance_topics`. All three are
 * verified no-ops: a bad HMAC is 401 (`Shopify.validateWebhook`), which is what the compliance
 * requirement asks of an invalid signature, and anything valid is 200.
 *
 * Teardown is `app/uninstalled`'s, run as soon as the tokens are revoked; doing it from the
 * delayed `shop/redact` would risk resurrecting an already-destroyed `ShopActor` just to delete
 * it again.
 *
 * `customers/redact` and `customers/data_request` are no-ops because Baton stores no customer
 * identity fields: no name, email, phone or address, and no `customer` selection in any order
 * query. The order rows it does store are keyed by order and line item, so there is no customer
 * to look one up by. The one caveat, and the reason this is specific rather than a blanket "no
 * customer data": `ShopOrder.note` and a line item's `properties` are free text a buyer may have
 * typed personal details into. They are stored as Shopify sends them and deleted with the shop
 * on `app/uninstalled`, never in response to a per-customer request, which Baton has no key to
 * satisfy. The privacy page says exactly this.
 *
 * `app/uninstalled` is therefore the sole teardown point, and its delivery budget is finite:
 * Shopify retries 8 times over roughly 4 hours. A shop that exhausts it strands its actor: the
 * `ShopSession` row survives, so the shop still reads as installed. Accepted deliberately.
 * Burning all 8 attempts takes a sustained multi-hour failure, so the loss is outage-bound and
 * correlated rather than a steady drip, and a stranded actor bills only storage, with nothing
 * calling it to add requests, rows or duration. It is not silent either: {@link Webhooks}'
 * `handle` logs every failure at Error with shop and topic, so a burned budget is visible and
 * can be cleaned up by hand.
 *
 * Acting on `shop/redact` as a backstop was considered and rejected. Doing it unconditionally is
 * the resurrection bug above. Guarding on a surviving `ShopSession` row avoids that but trades
 * the cost leak for a correctness risk: Shopify does not document whether `shop/redact` still
 * fires when a merchant reinstalls inside the 48-hour delay, the payload carries no timestamp
 * (`{ shop_id, shop_domain }`), and reinstall is a normal merchant flow, so a reinstalled shop
 * can read as a missed uninstall. Its session would recover on the next OAuth; its actor's
 * storage would not. Keep all three no-ops unless the suppression behavior is confirmed.
 *
 * @see https://shopify.dev/docs/apps/build/webhooks/troubleshoot
 */
const compliance = Effect.succeed(ok);

const make = Effect.gen(function* () {
  const shopify = yield* Shopify;
  const shopSessions = yield* ShopSessions;

  /**
   * Baton's `handleWebhook`: validates `request` (a rejection fails as `WebhookRejected` and
   * `handler` never runs), then runs `handler` under `annotateLogs({ shop, topic })`. The
   * receipt logs at Info before the handler, so a delivery is recorded even if it fails; any
   * failure or defect logs at Error and is re-raised (a tap, not a catch), so the answer is
   * non-2xx and Shopify retries.
   */
  const handle = Effect.fn("Webhooks.handle")(function* <E, R>(
    request: Request,
    handler: (
      webhook: ValidatedWebhook,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) {
    const webhook = yield* shopify.validateWebhook(request);
    return yield* Effect.gen(function* () {
      yield* Effect.logInfo(`Webhook received: shop=${webhook.shop} topic=${webhook.topic}`);
      return yield* handler(webhook);
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.logError(`Webhook failed: shop=${webhook.shop} topic=${webhook.topic}`, cause),
      ),
      Effect.annotateLogs({ shop: webhook.shop, topic: webhook.topic }),
    );
  });

  /** Rewrites the stored scope; a shop with no session row is left without one. */
  const scopesUpdate = Effect.fn("Webhooks.scopesUpdate")(function* (webhook: ValidatedWebhook) {
    const { current } = yield* decodeScopesUpdate(webhook.payload);
    yield* shopSessions.updateScope(webhook.shop, current.join(","));
    return ok;
  });

  /**
   * One handler per {@link WebhookTopic}. `app/uninstalled` and `orders/*` answer 200 and do
   * nothing yet, so a delivery is not retried for four hours against a handler that does not
   * exist.
   */
  const dispatch = (webhook: ValidatedWebhook) =>
    Option.match(decodeTopic(webhook.topic), {
      onNone: () =>
        Effect.logWarning(
          `Webhooks.dispatch: shop=${webhook.shop} topic=${webhook.topic}: no handler`,
        ).pipe(Effect.as(HttpServerResponse.empty({ status: 404 }))),
      onSome: (topic) =>
        Match.value(topic).pipe(
          Match.when(
            Match.is("CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT", "SHOP_REDACT"),
            () => compliance,
          ),
          Match.when("APP_SCOPES_UPDATE", () => scopesUpdate(webhook)),
          Match.when("APP_UNINSTALLED", () => Effect.succeed(ok)),
          Match.when(
            Match.is(
              "ORDERS_CREATE",
              "ORDERS_PAID",
              "ORDERS_EDITED",
              "ORDERS_CANCELLED",
              "ORDERS_FULFILLED",
            ),
            () => Effect.succeed(ok),
          ),
          Match.exhaustive,
        ),
    });

  /**
   * The Backend's `/webhooks/*` branch: {@link handle} over {@link dispatch}. The request goes
   * back to the web `Request` it came from, its body unread, since the HMAC is over the exact
   * raw bytes. A rejection answers its status; any other failure, already logged by `handle`,
   * answers 500.
   */
  const serve = Effect.fn("Webhooks.serve")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
    return yield* handle(web, dispatch).pipe(
      Effect.catchTag("WebhookRejected", ({ status }) =>
        Effect.succeed(HttpServerResponse.empty({ status })),
      ),
      Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 500 }))),
    );
  });

  return { handle, serve };
});

/**
 * Shopify's webhooks, served by the Backend under `/webhooks/`. The Website forwards each
 * request untouched; the HMAC is the only credential, so there is no Origin check.
 */
export class Webhooks extends Context.Service<Webhooks, Effect.Success<typeof make>>()(
  "app/Webhooks",
) {
  static readonly layer = Layer.effect(Webhooks, make);
}
