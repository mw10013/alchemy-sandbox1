import { createFileRoute } from "@tanstack/react-router";
import { appBridgePage } from "../server/app-bridge-page.ts";

/**
 * Baton's session-token bounce: the App Bridge-only page. App Bridge reads `shopify-reload` from
 * the URL and reloads that page with a fresh `id_token`; without it, the Shopify admin re-embeds the app.
 */
export const Route = createFileRoute("/auth/session-token")({
  server: {
    handlers: {
      GET: ({ request }) => appBridgePage(new URL(request.url).searchParams.get("shop")),
    },
  },
});
