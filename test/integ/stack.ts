import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Backend from "../../src/backend/worker.ts";

/**
 * The Backend alone, for the test harness. The Website is left out: under dev it would start
 * the TanStack Start dev server and want `WEBSITE_PORT`. Better Auth builds links on
 * `AUTH_ORIGIN`, which the real stack binds to the Website's URL; here the Backend is its own
 * origin, so a link can be followed against it directly.
 */
export default Alchemy.Stack(
  "Alchemy-sandbox1-test",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const backend = yield* Backend;
    yield* backend.bind("AuthOrigin", { env: { AUTH_ORIGIN: backend.url } });
    return { backendUrl: backend.url.as<string>() };
  }),
);
