import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { DeliveryMode } from "./src/backend/magic-link-delivery.ts";
import { SHOPIFY_API_KEY } from "./src/backend/shopify.ts";
import Backend from "./src/backend/worker.ts";
import { ShopifyApp, stageState, wireBackend } from "./src/backend/stack.ts";

/**
 * The TanStack Start app. `alchemy dev` serves it on `WEBSITE_PORT` from the checkout's `.env`
 * (Alchemy loads `.env` itself); deploys never read it. `strictPort` makes a collision fail
 * instead of silently moving ports.
 *
 * `SHOPIFY_API_KEY` goes into the App Home's page, so it is public; the secret stays on the
 * Backend. It is the real app's where {@link ShopifyApp} has one and the fake key elsewhere;
 * `SHOPIFY_APP_URL` is the real app's own URL when it has one and the Website's otherwise.
 */
export class Website extends Cloudflare.Website.Vite<Website>()(
  "Website",
  Effect.gen(function* () {
    const dev = (yield* Alchemy.ALCHEMY_DEV)
      ? { port: yield* Config.Port("WEBSITE_PORT"), strictPort: true }
      : undefined;
    const app = yield* ShopifyApp;
    return {
      compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
      dev,
      env: {
        BACKEND: Backend,
        SHOPIFY_API_KEY: Option.match(app, {
          onNone: () => SHOPIFY_API_KEY,
          onSome: ({ apiKey }) => apiKey,
        }),
        SHOPIFY_APP_URL: Option.match(
          Option.flatMap(app, ({ appUrl }) => appUrl),
          {
            onNone: () => Cloudflare.Worker.URL,
            onSome: (appUrl) => appUrl,
          },
        ),
      },
    };
  }).pipe(Effect.orDie),
) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

/**
 * The state store follows the stage's environment ({@link stageState}).
 *
 * `E2E_TOKEN`, when the environment has it, is bound to the Backend, which then serves the
 * test-control procedures. Whoever runs the tests supplies it; the stack never generates or
 * stores it.
 *
 * Magic links are delivered inline under `alchemy dev` and on a stage with `E2E_TOKEN`, where
 * a sign-in page or a test runner takes them; every other stage mails them.
 */
export default Alchemy.Stack(
  "baton",
  { providers: Cloudflare.providers(), state: stageState },
  Effect.gen(function* () {
    const website = yield* Website;
    const backend = yield* Backend;
    const e2eToken = yield* Config.option(Config.String("E2E_TOKEN"));
    const delivery: DeliveryMode =
      (yield* Alchemy.ALCHEMY_DEV) || Option.isSome(e2eToken) ? "inline" : "mailed";
    yield* wireBackend(backend, {
      // Better Auth in the Backend builds magic links on the Website's origin. The Website
      // already binds the Backend, so its URL is attached as a binding, which may form a
      // cycle, rather than as a Backend prop. Under alchemy dev it is the local dev URL.
      authOrigin: website.url,
      appUrl: website.url,
      delivery,
      e2eToken,
    });
    return { websiteUrl: website.url.as<string>(), backendUrl: backend.url.as<string>() };
  }),
);
