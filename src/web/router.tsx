import { RegistryContext, scheduleTask } from "@effect/atom-react";
import { createRouter } from "@tanstack/react-router";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { StrictMode } from "react";
import { routeTree } from "./routeTree.gen";

/**
 * Builds the router and its atom registry. It runs once per request on the server and once in
 * the browser, so each gets its own registry. Only the actor socket's atoms live in it, and
 * they are seeded in the browser from loader data, never read on the server, so nothing is
 * dehydrated. The server registry is not disposed explicitly: workerd tears down the request
 * context, and its timers, when the response finishes.
 *
 * The tree runs under `StrictMode`, so in development React renders twice, runs state
 * initializers twice and mounts effects twice; code that cannot bear that is a bug it finds.
 */
export function getRouter() {
  const registry = AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 });

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    context: { registry },
    Wrap: ({ children }) => (
      <StrictMode>
        <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
      </StrictMode>
    ),
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
