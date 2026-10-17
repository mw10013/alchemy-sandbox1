import { createFileRoute } from "@tanstack/react-router";
import { isCrossSiteUpgrade } from "../server/actor-upgrade.ts";
import { env } from "../server/env.server.ts";
import { text } from "../server/rpc-proxy.ts";

/**
 * Forwards a WebSocket upgrade for one shop's actor to `Backend`, whose gate decides who may
 * open it; the key is decoded there. Only the upgrade: the actor has no HTTP surface a browser
 * can reach. An upgrade from another site ({@link isCrossSiteUpgrade}) is refused with 403.
 */
export const Route = createFileRoute("/api/actor/$key")({
  server: {
    handlers: {
      GET: ({ request }) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          return text(426, "Upgrade Required", { upgrade: "websocket" });
        if (isCrossSiteUpgrade(request)) return text(403, "Forbidden");
        return env.BACKEND.fetch(request);
      },
    },
  },
});
