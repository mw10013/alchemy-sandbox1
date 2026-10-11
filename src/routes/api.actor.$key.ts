import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env.server.ts";
import { rejectRequest, text } from "../rpc-proxy.ts";

/**
 * Forwards one shop's actor traffic to `Backend`, which checks the session and selects the
 * actor: a WebSocket upgrade on GET, Effect RPC on POST (after {@link rejectRequest}). The key
 * is decoded by the Backend; this route only carries it.
 */
export const Route = createFileRoute("/api/actor/$key")({
  server: {
    handlers: {
      GET: ({ request }) =>
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
          ? env.BACKEND.fetch(request)
          : text(426, "Upgrade Required", { upgrade: "websocket" }),
      POST: ({ request }) => rejectRequest(request) ?? env.BACKEND.fetch(request),
    },
  },
});
