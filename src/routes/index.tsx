import { createFileRoute } from "@tanstack/react-router";
import HomePage from "../components/HomePage";
import { helloAtom } from "../backend-client.ts";
import { loadQuery } from "../query.ts";

export const Route = createFileRoute("/")({
  // A failed Hello rejects, and the route error boundary shows it.
  loader: async ({ context }) => {
    await loadQuery(context.registry, helloAtom);
  },
  component: HomePage,
});
