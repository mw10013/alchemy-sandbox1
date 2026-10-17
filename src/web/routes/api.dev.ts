import { createFileRoute } from "@tanstack/react-router";
import { env } from "../server/env.server.ts";
import { rejectRequest, text } from "../server/rpc-proxy.ts";

/**
 * Forwards the dev procedures (`vp run fixture`, e2e) to `Backend`, after {@link rejectRequest}.
 * The Backend answers 404 unless the stage binds `DEV_ENDPOINT`, so this route exposes nothing on
 * its own.
 */
export const Route = createFileRoute("/api/dev")({
  server: {
    handlers: {
      POST: ({ request }) => rejectRequest(request) ?? env.BACKEND.fetch(request),
      GET: () => text(405, "Method Not Allowed", { allow: "POST" }),
    },
  },
});
