import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { env } from "../server/env.server.ts";
import { appBridgePage } from "../server/app-bridge-page.ts";
import { exitIframeDestination } from "../server/shopify-urls.ts";

/**
 * A string for a classic inline script: JSON with `<` escaped, because the HTML parser ends the
 * script at `</script>` before JavaScript sees the quotes.
 */
const inlineScriptString = (value: string) =>
  JSON.stringify(value).replaceAll("<", String.raw`\u003c`);

/**
 * Baton's exit-iframe page: App Bridge, then the top window sent to `?exitIframe` (the app's URL
 * when absent), for a destination the Shopify admin cannot frame. A destination
 * {@link exitIframeDestination} refuses is `400`, so the route is never an open redirect.
 */
export const Route = createFileRoute("/auth/exit-iframe")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const search = new URL(request.url).searchParams;
        return Option.match(
          exitIframeDestination(
            env.SHOPIFY_APP_URL,
            search.get("exitIframe") ?? env.SHOPIFY_APP_URL,
          ),
          {
            onNone: () =>
              new Response("Bad Request", {
                status: 400,
                headers: { "content-type": "text/plain" },
              }),
            onSome: (destination) =>
              appBridgePage(
                search.get("shop"),
                `<script>window.open(${inlineScriptString(destination.href)}, "_top")</script>`,
              ),
          },
        );
      },
    },
  },
});
