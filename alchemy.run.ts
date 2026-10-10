import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import Backend from "./src/backend/worker.ts";

// `alchemy dev` serves on WEBSITE_PORT from the checkout's .env (Alchemy loads
// .env itself); deploys never read it. strictPort makes a collision fail
// instead of silently moving ports.
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

export default Alchemy.Stack(
  "Alchemy-sandbox1",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const website = yield* Website;
    return { websiteUrl: website.url.as<string>() };
  }),
);
