import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env.server.ts";

// Browser → Website → Backend. The binding ignores the host; RpcServer ignores the path.
export const Route = createFileRoute("/api/rpc")({
  server: {
    handlers: {
      POST: ({ request }) => env.BACKEND.fetch(request),
    },
  },
});
