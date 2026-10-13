import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { SHOPIFY_API_KEY } from "../../src/backend/shopify.ts";
import Backend from "../../src/backend/worker.ts";

/** The integ stage's test-control token, so the tests can drive test control. */
const INTEG_E2E_TOKEN = "integ";

/**
 * The Backend alone, for the test harness. The Website is left out: under dev it would start
 * the TanStack Start dev server and want `WEBSITE_PORT`. Better Auth builds links on
 * `AUTH_ORIGIN`, which the real stack binds to the Website's URL; here the Backend is its own
 * origin, so a link can be followed against it directly. Links are delivered inline, so the
 * test gets them back from test control's `IssueMagicLink`. The fake Shopify secret is bound as
 * on the real stack, and test control is on.
 */
export default Alchemy.Stack(
  "Alchemy-sandbox1-test",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const backend = yield* Backend;
    yield* backend.bind("AuthOrigin", { env: { AUTH_ORIGIN: backend.url } });
    yield* backend.bind("MagicLinkDelivery", { env: { MAGIC_LINK_DELIVERY: "inline" } });
    yield* backend.bind("Shopify", {
      env: {
        SHOPIFY_API_KEY: SHOPIFY_API_KEY,
        SHOPIFY_API_SECRET: yield* Alchemy.makeRandom("ShopifyApiSecret"),
      },
    });
    yield* backend.bind("TestControl", { env: { E2E_TOKEN: INTEG_E2E_TOKEN } });
    return { backendUrl: backend.url.as<string>(), e2eToken: INTEG_E2E_TOKEN };
  }),
);
