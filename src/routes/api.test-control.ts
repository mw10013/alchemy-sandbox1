import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env.server.ts";
import { rejectRequest, text } from "../rpc-proxy.ts";

/**
 * Forwards test-control RPC to `Backend`, after {@link rejectRequest}. The Backend answers 404
 * unless the stage has the `E2E_TOKEN` binding, so this route exposes nothing on its own.
 */
export const Route = createFileRoute("/api/test-control")({
  server: {
    handlers: {
      POST: ({ request }) => rejectRequest(request) ?? env.BACKEND.fetch(request),
      GET: () => text(405, "Method Not Allowed", { allow: "POST" }),
    },
  },
});
