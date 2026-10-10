import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import stylesheet from "../styles.css?url";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Heading } from "@astryxdesign/core/Heading";

export const Route = createRootRouteWithContext<{ registry: AtomRegistry.AtomRegistry }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Alchemy-sandbox1" },
      { name: "description", content: "Alchemy, Effect, TanStack Start, and Astryx smoke test." },
    ],
    links: [{ rel: "stylesheet", href: stylesheet }],
  }),
  notFoundComponent: () => (
    <AppShell contentPadding={6}>
      <Heading level={1}>Page not found</Heading>
    </AppShell>
  ),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ),
});
