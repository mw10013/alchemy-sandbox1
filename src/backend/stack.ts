/**
 * What both stacks, the real one and the integ harness's, share: the state store and the
 * Backend's wiring. Stack-time only; the Backend bundle never imports it.
 *
 * @module
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { DeliveryMode } from "./magic-link-delivery.ts";
import { seed } from "./seed.ts";
import { SHOPIFY_API_KEY } from "./shopify.ts";
import { environmentOf } from "./stage.ts";
import type Backend from "./worker.ts";

/**
 * The stack's state store, chosen by the stage's environment. State lives where the resources
 * live: `dev`, `test` and `e2e` run entirely in workerd and its simulators, so their state is
 * local under `.alchemy/` and goes with the checkout's local data; `staging` runs in Cloudflare,
 * so its state does too. A per-developer environment that gains a resource running live under
 * `alchemy dev` (`Alchemy.remote()`, or a service with no local simulator) moves to
 * `Cloudflare.state()` when that resource lands, or its records outlive or lose the resource.
 *
 * `Test.make`'s own `state` option is built outside the stage, so integ files pass none and the
 * harness uses this layer from the stack.
 */
export const stageState = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* environmentOf(yield* Alchemy.Stage).pipe(Effect.orDie);
    return Match.value(environment).pipe(
      Match.whenOr("dev", "test", "e2e", () => Alchemy.localState()),
      Match.when("staging", () => Cloudflare.state()),
      Match.exhaustive,
    );
  }),
);

/**
 * The Shopify app this run serves, `Some` only when all three variables are present. Shopify CLI
 * injects them into the web command it runs, so they exist only under `shopify app dev`, which
 * runs `alchemy dev` as that command; everywhere else (integ, e2e, a plain `alchemy dev`,
 * staging) they are absent and the fakes in {@link wireBackend} stand in. The process
 * environment wins over `.env`, so `.env` cannot shadow them.
 */
export const ShopifyApp = Config.all({
  appUrl: Config.option(Config.String("APP_URL")),
  apiKey: Config.option(Config.String("SHOPIFY_API_KEY")),
  apiSecret: Config.option(Config.Redacted("SHOPIFY_API_SECRET")),
}).pipe(Config.map(Option.all));

/**
 * Seeds the stage and binds the Backend's configuration. The two stacks differ only in the
 * options; every other binding is here, so a new one is added once. The binding names and the
 * `ShopifyApiSecret` id are logical ids in state: renaming one recreates it on every stage.
 *
 * The Shopify API key and secret are the real app's under `shopify app dev` ({@link ShopifyApp})
 * and fakes elsewhere: a fixed key and a random secret held in state. The random secret is
 * declared on every stage, so its state record does not come and go with the CLI; only the
 * binding's value differs. `appUrl` is the app's public URL, the CLI's tunnel under the CLI.
 * `e2eToken`, when some, turns test control on.
 */
export const wireBackend = Effect.fn("wireBackend")(function* (
  backend: Effect.Success<typeof Backend>,
  options: {
    readonly authOrigin: Alchemy.Output<string | undefined>;
    readonly appUrl: Alchemy.Output<string | undefined>;
    readonly delivery: DeliveryMode;
    readonly e2eToken: Option.Option<string>;
  },
) {
  yield* seed(backend);
  yield* backend.bind("AuthOrigin", { env: { AUTH_ORIGIN: options.authOrigin } });
  yield* backend.bind("MagicLinkDelivery", { env: { MAGIC_LINK_DELIVERY: options.delivery } });
  const fakeSecret = yield* Alchemy.makeRandom("ShopifyApiSecret");
  const app = yield* ShopifyApp;
  yield* backend.bind("Shopify", {
    env: Option.match(app, {
      onNone: () => ({
        SHOPIFY_API_KEY: SHOPIFY_API_KEY,
        SHOPIFY_API_SECRET: fakeSecret,
        SHOPIFY_APP_URL: options.appUrl,
      }),
      onSome: ({ apiKey, apiSecret, appUrl }) => ({
        SHOPIFY_API_KEY: apiKey,
        SHOPIFY_API_SECRET: apiSecret,
        SHOPIFY_APP_URL: appUrl,
      }),
    }),
  });
  if (Option.isSome(options.e2eToken))
    yield* backend.bind("TestControl", { env: { E2E_TOKEN: options.e2eToken.value } });
});
