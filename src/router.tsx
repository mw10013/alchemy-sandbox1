import { RegistryContext, scheduleTask } from "@effect/atom-react";
import { createRouter } from "@tanstack/react-router";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Hydration from "effect/reactivity/Hydration";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  // One registry per router. getRouter() runs once per request on the server and once in the browser.
  const registry = AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 });

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    // The registry is the stale-while-revalidate layer. A background router reload would
    // render a TTL-expired query as Initial ("Loading…") before loadQuery finishes.
    defaultStaleReloadMode: "blocking",
    context: { registry },
    Wrap: ({ children }) => (
      <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
    ),
    dehydrate: () => ({ atoms: Hydration.dehydrate(registry) }),
    hydrate: ({ atoms }) => {
      Hydration.hydrate(registry, atoms);
    },
  });

  // The server registry is not disposed explicitly: workerd tears down the request
  // context, and its timers, when the response finishes.
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
