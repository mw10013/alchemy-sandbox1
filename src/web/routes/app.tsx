import { createFileRoute, redirect } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { APP_BRIDGE_URL } from "../components/polaris.ts";
import { authenticateApp, getShopifyApp } from "../server/shopify.ts";
import { embeddedAppUrl, frameAncestors, sessionTokenBounce } from "../server/shopify-urls.ts";

/**
 * What Shopify puts on the App Home's URL, read from the raw search string. The router parses each
 * search value as JSON (`embedded=1` becomes the number `1`) and rewrites the URL when
 * `validateSearch` returns anything else, so the route keeps the router's search as it is and the
 * guards decode the text Shopify sent. Shopify also sends `locale`, `session`, `timestamp` and
 * `hmac`; every redirect is built from the raw string, so they survive the round trip.
 */
const AppSearch = Schema.Struct({
  shop: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  embedded: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
});
const decodeSearch = Schema.decodeUnknownOption(AppSearch);
const appSearch = (searchStr: string): typeof AppSearch.Type =>
  Option.getOrElse(decodeSearch(Object.fromEntries(new URLSearchParams(searchStr))), () => ({}));

/**
 * The embedded App Home, the page the admin frames. `beforeLoad` runs Baton's document guards,
 * first match wins, each a redirect: no `shop` or `host` goes to the App Bridge-only page, which
 * re-embeds; `embedded !== "1"` goes to the app inside the admin; no `id_token` goes to the
 * session-token bounce; otherwise the token is authenticated (`authenticateApp`). App Bridge is
 * the document's first script, which the admin requires; the root document places
 * `HeadContent` ahead of Polaris for it.
 */
export const Route = createFileRoute("/app")({
  beforeLoad: async ({ location }) => {
    const search = appSearch(location.searchStr);
    const { apiKey, appUrl } = await getShopifyApp();
    const reEmbed = `/auth/session-token${location.searchStr}`;
    if (search.shop === undefined || search.host === undefined) throw redirect({ href: reEmbed });
    if (search.embedded !== "1")
      throw redirect({
        href: Option.getOrElse(embeddedAppUrl(search.host, apiKey), () => reEmbed),
      });
    if (search.id_token === undefined)
      throw redirect({ href: sessionTokenBounce(appUrl, location.pathname, location.searchStr) });
    return await authenticateApp({ data: { idToken: search.id_token } });
  },
  head: ({ match }) => ({
    meta: [{ name: "shopify-api-key", content: match.context.apiKey }],
    scripts: [{ src: APP_BRIDGE_URL }],
  }),
  headers: ({ match }) =>
    Option.match(frameAncestors(match.context.shop), {
      onNone: () => ({}),
      onSome: (csp): Record<string, string> => ({ "Content-Security-Policy": csp }),
    }),
  component: function AppHome() {
    const { shop } = Route.useRouteContext();
    return (
      <s-page heading="Alchemy-sandbox1">
        <s-section heading="We got here">
          <s-paragraph>{shop}</s-paragraph>
        </s-section>
      </s-page>
    );
  },
});
