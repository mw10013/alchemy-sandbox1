import { createFileRoute } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import HomePage from "../components/HomePage";
import { helloAtom } from "../backend-client.ts";

export const Route = createFileRoute("/")({
  // Prime the query atom so SSR renders with data and dehydrate captures it.
  // Returns nothing: the value travels in the dehydrated registry, not in loaderData.
  // A failed Hello rejects the loader and the route error boundary shows it.
  loader: async ({ context }) => {
    await Effect.runPromise(
      AtomRegistry.getResult(context.registry, helloAtom, { suspendOnWaiting: true }),
    );
  },
  component: HomePage,
});
