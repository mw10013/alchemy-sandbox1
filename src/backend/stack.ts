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
import type * as Redacted from "effect/Redacted";
import type { DeliveryMode } from "./magic-link-delivery.ts";
import { seed } from "./seed.ts";
import { SHOPIFY_API_KEY } from "./shopify.ts";
import { environmentOf } from "./stage.ts";
import type Backend from "./worker.ts";

/** The fields of {@link StageConfig}'s record, named after the bindings they become. */
export interface StageConfigValues {
  readonly SHOPIFY_API_KEY: string;
  readonly SHOPIFY_API_SECRET: Redacted.Redacted<string>;
}

/**
 * The values another service issues for a deployed stage, held as the output of their own stack
 * so that a deploy in Workers Builds, which has no way to receive them as environment variables,
 * reads them from the state store instead. A secret is `Redacted`, which is what binds it as a
 * Worker secret. Deployed by hand from a laptop, before any deploy of code that reads a new
 * field; every deploy writes the whole record. The stack name is a logical id in state: renaming
 * it orphans every stage's record.
 */
export class StageConfig extends Alchemy.Stack<StageConfig, StageConfigValues>()("baton-config") {}

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

/** A real Shopify app's credentials, as {@link ShopifyApp} chooses them. */
export interface ShopifyAppConfig {
  readonly apiKey: string | Alchemy.Output<string>;
  readonly apiSecret: Redacted.Redacted<string> | Alchemy.Output<Redacted.Redacted<string>>;
  /** The app's public URL when it is not the Website's own: Shopify CLI's tunnel. */
  readonly appUrl: Option.Option<string>;
}

/**
 * Shopify CLI's app, `Some` only when all three variables are present. The CLI injects them into
 * the web command it runs, so they exist only under `shopify app dev`, which runs `alchemy dev`
 * as that command. The process environment wins over `.env`, so `.env` cannot shadow them.
 */
const shopifyCliApp = Config.all({
  appUrl: Config.option(Config.String("APP_URL")),
  apiKey: Config.option(Config.String("SHOPIFY_API_KEY")),
  apiSecret: Config.option(Config.Redacted("SHOPIFY_API_SECRET")),
}).pipe(
  Config.map(Option.all),
  Config.map(Option.map((app): ShopifyAppConfig => ({ ...app, appUrl: Option.some(app.appUrl) }))),
);

/**
 * The real Shopify app this stage serves, chosen by the stage's environment; `None` means the
 * fakes in {@link wireBackend} stand in. `staging` reads its app from {@link StageConfig}'s record
 * and never from `Config`, so a stray variable in the Workers Builds environment cannot override
 * it, and a missing record fails the plan rather than falling back to the fakes; its app URL is
 * the Website's own. `dev` and `e2e` serve Shopify CLI's app under `shopify app dev` and the
 * fakes otherwise (a bare `alchemy destroy` of the e2e stage); `test` always uses the fakes.
 */
export const ShopifyApp: Effect.Effect<
  Option.Option<ShopifyAppConfig>,
  Config.ConfigError,
  Alchemy.Stage
> = Effect.gen(function* () {
  const environment = yield* environmentOf(yield* Alchemy.Stage).pipe(Effect.orDie);
  return yield* Match.value(environment).pipe(
    Match.when("staging", () =>
      Effect.map(StageConfig, (record) =>
        Option.some<ShopifyAppConfig>({
          apiKey: record.SHOPIFY_API_KEY,
          apiSecret: record.SHOPIFY_API_SECRET,
          appUrl: Option.none(),
        }),
      ),
    ),
    Match.whenOr("dev", "e2e", () => shopifyCliApp),
    Match.when("test", () => Effect.succeedNone),
    Match.exhaustive,
  );
});

/**
 * Seeds the stage and binds the Backend's configuration. The two stacks differ only in the
 * options; every other binding is here, so a new one is added once. The binding names and the
 * `ShopifyApiSecret` id are logical ids in state: renaming one recreates it on every stage.
 *
 * The Shopify API key and secret are the real app's where {@link ShopifyApp} has one and fakes
 * elsewhere: a fixed key and a random secret held in state. The random secret is declared on
 * every stage, so its state record does not come and go with the CLI; only the binding's value
 * differs. `appUrl` is the Website's URL, used unless the real app has its own.
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
        SHOPIFY_APP_URL: Option.getOrElse(appUrl, () => options.appUrl),
      }),
    }),
  });
  const environment = yield* environmentOf(yield* Alchemy.Stage).pipe(Effect.orDie);
  // The fake replaces the Shopify library's one HTTP function, so it must never sit in front of
  // a real app: only `test`, which always uses the fake app, gets it. The value is "on", not
  // "1": the runtime reads a numeric-looking binding as a number, which `Config.String` refuses,
  // and the Worker then fails every request.
  yield* Match.value(environment).pipe(
    Match.when("test", () => backend.bind("ShopifyFake", { env: { SHOPIFY_FAKE_HTTP: "on" } })),
    Match.whenOr("dev", "e2e", "staging", () => Effect.void),
    Match.exhaustive,
  );
  // The fixture replaces a shop's data, so only the per-developer environments, whose data is
  // disposable, mount it; staging never does.
  yield* Match.value(environment).pipe(
    Match.whenOr("dev", "test", "e2e", () =>
      backend.bind("Fixture", { env: { FIXTURE_ENDPOINT: "on" } }),
    ),
    Match.when("staging", () => Effect.void),
    Match.exhaustive,
  );
  if (Option.isSome(options.e2eToken))
    yield* backend.bind("TestControl", { env: { E2E_TOKEN: options.e2eToken.value } });
});
