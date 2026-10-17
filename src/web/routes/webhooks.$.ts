import { createFileRoute } from "@tanstack/react-router";
import { env } from "../server/env.server.ts";
import { text } from "../server/rpc-proxy.ts";

/**
 * Forwards Shopify's webhooks to `Backend`, which checks them. The request goes untouched: the
 * HMAC is over the exact raw body, and it is the only credential, so there is no Origin check
 * and no `rejectRequest`.
 */
export const Route = createFileRoute("/webhooks/$")({
  server: {
    handlers: {
      POST: ({ request }) => env.BACKEND.fetch(request),
      ANY: () => text(405, "Method Not Allowed", { allow: "POST" }),
    },
  },
});
