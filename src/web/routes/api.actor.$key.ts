import { createFileRoute } from "@tanstack/react-router";
import { env } from "../server/env.server.ts";
import { text } from "../server/rpc-proxy.ts";

/**
 * Forwards a WebSocket upgrade for one shop's actor to `Backend`, whose gate decides who may
 * open it; the key is decoded there. Only the upgrade: the actor has no HTTP surface a browser
 * can reach.
 *
 * An upgrade whose `Origin` is present and is not this site is refused with 403. Browsers
 * always send `Origin` on a WebSocket upgrade and a page cannot change it, so this stops
 * another site from opening a socket with the visitor's cookie.
 */
export const Route = createFileRoute("/api/actor/$key")({
  server: {
    handlers: {
      GET: ({ request }) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          return text(426, "Upgrade Required", { upgrade: "websocket" });
        const origin = request.headers.get("origin");
        if (origin !== null && origin !== new URL(request.url).origin)
          return text(403, "Forbidden");
        return env.BACKEND.fetch(request);
      },
    },
  },
});
