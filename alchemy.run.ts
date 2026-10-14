import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { DeliveryMode } from "./src/backend/magic-link-delivery.ts";
import Backend from "./src/backend/worker.ts";
import { stageState, wireBackend } from "./src/backend/stack.ts";

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
  "Alchemy-sandbox1",
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
      delivery,
      e2eToken,
    });
    return { websiteUrl: website.url.as<string>(), backendUrl: backend.url.as<string>() };
  }),
);
