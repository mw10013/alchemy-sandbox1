import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  useHydrated,
} from "@tanstack/react-router";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import stylesheet from "../styles.css?url";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Heading } from "@astryxdesign/core/Heading";
import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import type { ReactNode } from "react";
import RouterLink from "../components/RouterLink";

/**
 * The document every page renders in, and the home of the site-wide UI conventions.
 *
 * Theme: the built neutral theme, fixed to dark. The built object matches the precompiled
 * `theme.css` in `styles.css`, so the server render is already themed.
 *
 * Copy:
 * - A button or link names its action in one or two words: "Send link", "Sign out",
 *   "Dashboard".
 * - At most one supporting line per heading or field, and it never restates the heading,
 *   label or button.
 * - No developer detail in user-facing text: no error tags, defects, transport or
 *   architecture terms. Say what happened and what to do: "Couldn't reach the server. Try
 *   again."
 * - No placeholder that repeats its label.
 *
 * `data-hydrated` on `<body>` marks that React has attached its handlers. Browser tests wait for
 * it after a full page load, because a click before then is lost. {@link useHydrated} is false
 * on the server and on the first client render, so the server markup and the hydration render
 * agree.
 */
function RootDocument({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body data-hydrated={hydrated ? "" : undefined}>
        <Theme theme={neutralTheme} mode="dark">
          <LinkProvider component={RouterLink}>{children}</LinkProvider>
        </Theme>
        <Scripts />
      </body>
    </html>
  );
}

export const Route = createRootRouteWithContext<{ registry: AtomRegistry.AtomRegistry }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Alchemy-sandbox1" },
      { name: "description", content: "TanStack Start, Effect and Astryx on Cloudflare Workers." },
    ],
    links: [{ rel: "stylesheet", href: stylesheet }],
  }),
  notFoundComponent: () => (
    <AppShell contentPadding={6}>
      <Heading level={1}>Page not found</Heading>
    </AppShell>
  ),
  shellComponent: RootDocument,
});
