import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/rpc")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleProbeRpc } = await import("../server/probe/rpc.server");
        return handleProbeRpc(request);
      },
    },
  },
});
