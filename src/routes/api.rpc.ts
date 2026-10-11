import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env.server.ts";
import { rejectRequest, text } from "../rpc-proxy.ts";

/** Forwards Effect RPC to `Backend`, after {@link rejectRequest}. */
export const Route = createFileRoute("/api/rpc")({
  server: {
    handlers: {
      POST: ({ request }) => rejectRequest(request) ?? env.BACKEND.fetch(request),
      // WebSocket upgrades are GETs too; they get 405 until the Durable Object phase.
      GET: () => text(405, "Method Not Allowed", { allow: "POST" }),
    },
  },
});
