import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { DeliveryMode } from "./src/backend/magic-link-delivery.ts";
import Backend from "./src/backend/worker.ts";
import { seedAuth } from "./src/backend/auth-seed.ts";
import { SHOPIFY_API_KEY } from "./src/backend/shopify.ts";

/**
 * The TanStack Start app. `alchemy dev` serves it on `WEBSITE_PORT` from the checkout's `.env`
 * (Alchemy loads `.env` itself); deploys never read it. `strictPort` makes a collision fail
 * instead of silently moving ports.
 */
export class Website extends Cloudflare.Website.Vite<Website>()(
  "Website",
  Effect.gen(function* () {
    const dev = (yield* Alchemy.ALCHEMY_DEV)
      ? { port: yield* Config.Port("WEBSITE_PORT"), strictPort: true }
      : undefined;
    return {
      compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
      dev,
      env: { BACKEND: Backend },
    };
  }).pipe(Effect.orDie),
) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

/**
 * State lives in Cloudflare, except with `ALCHEMY_STATE=local`: e2e stages keep their state
 * under `.alchemy/` like the test harness does, so they need no state-store credentials and
 * leave no remote rows.
 *
 * `E2E_TOKEN`, when the environment has it, is bound to the Backend, which then serves the
 * test-control procedures. Whoever runs the tests supplies it; the stack never generates or
 * stores it. It is refused on the production stage.
 *
 * The fake Shopify app's secret is a random value held in state; the Shopify API key is a fixed
 * fake. Both are fakes until the Shopify slice brings a real app.
 *
 * Magic links are delivered inline under `alchemy dev` and on a stage with `E2E_TOKEN`, where
 * a sign-in page or a test runner takes them; every other stage mails them. Production never
 * delivers inline.
 */
export default Alchemy.Stack(
  "Alchemy-sandbox1",
  {
    providers: Cloudflare.providers(),
    state: process.env.ALCHEMY_STATE === "local" ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const website = yield* Website;
    // Better Auth in the Backend builds magic links on the Website's origin. The Website
    // already binds the Backend, so its URL is attached as a binding, which may form a
    // cycle, rather than as a Backend prop. Under alchemy dev it is the local dev URL.
    const backend = yield* Backend;
    yield* seedAuth(backend);
    yield* backend.bind("AuthOrigin", { env: { AUTH_ORIGIN: website.url } });
    const stage = yield* Alchemy.Stage;
    const e2eToken = yield* Config.option(Config.String("E2E_TOKEN"));
    if (stage === "production" && Option.isSome(e2eToken))
      return yield* Effect.die(new Error("E2E_TOKEN is set on the production stage"));
    const delivery: DeliveryMode =
      (yield* Alchemy.ALCHEMY_DEV) || Option.isSome(e2eToken) ? "inline" : "mailed";
    if (stage === "production" && delivery === "inline")
      return yield* Effect.die(new Error("the production stage would deliver magic links inline"));
    yield* backend.bind("MagicLinkDelivery", { env: { MAGIC_LINK_DELIVERY: delivery } });
    yield* backend.bind("Shopify", {
      env: {
        SHOPIFY_API_KEY: SHOPIFY_API_KEY,
        SHOPIFY_API_SECRET: yield* Alchemy.makeRandom("ShopifyApiSecret"),
      },
    });
    if (Option.isSome(e2eToken))
      yield* backend.bind("TestControl", { env: { E2E_TOKEN: e2eToken.value } });
    return { websiteUrl: website.url.as<string>(), backendUrl: backend.url.as<string>() };
  }),
);
