import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { APP_BRIDGE_URL } from "../components/polaris.ts";
import { authenticateApp, getShopifyApp } from "../server/shopify.ts";
import { appSearch } from "./-app-search.ts";
import { embeddedAppUrl, frameAncestors, sessionTokenBounce } from "../server/shopify-urls.ts";

/**
 * The embedded App Home's layout, around every page the Shopify admin frames under `/app`.
 * `beforeLoad` runs, for every one of them, Baton's document guards,
 * first match wins, each a redirect: no `shop` or `host` goes to the App Bridge-only page, which
 * re-embeds; `embedded !== "1"` goes to the app inside the Shopify admin; no `id_token` goes to the
 * session-token bounce; otherwise the token is authenticated (`authenticateApp`). App Bridge is
 * the document's first script, which the Shopify admin requires; the root document places
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
  component: Outlet,
});
