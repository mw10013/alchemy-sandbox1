/**
 * What both stacks, the real one and the integ harness's, share: the state store and the
 * Backend's wiring. Stack-time only; the Backend bundle never imports it.
 *
 * @module
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
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
 * Seeds the stage and binds the Backend's configuration. The two stacks differ only in the
 * options; every other binding is here, so a new one is added once. The binding names and the
 * `ShopifyApiSecret` id are logical ids in state: renaming one recreates it on every stage.
 *
 * The Shopify API key is a fixed fake and the secret a random value held in state, both fakes
 * until the Shopify slice brings a real app. `e2eToken`, when some, turns test control on.
 */
export const wireBackend = Effect.fn("wireBackend")(function* (
  backend: Effect.Success<typeof Backend>,
  options: {
    readonly authOrigin: Alchemy.Output<string | undefined>;
    readonly delivery: DeliveryMode;
    readonly e2eToken: Option.Option<string>;
  },
) {
  yield* seed(backend);
  yield* backend.bind("AuthOrigin", { env: { AUTH_ORIGIN: options.authOrigin } });
  yield* backend.bind("MagicLinkDelivery", { env: { MAGIC_LINK_DELIVERY: options.delivery } });
  yield* backend.bind("Shopify", {
    env: {
      SHOPIFY_API_KEY: SHOPIFY_API_KEY,
      SHOPIFY_API_SECRET: yield* Alchemy.makeRandom("ShopifyApiSecret"),
    },
  });
  if (Option.isSome(options.e2eToken))
    yield* backend.bind("TestControl", { env: { E2E_TOKEN: options.e2eToken.value } });
});
