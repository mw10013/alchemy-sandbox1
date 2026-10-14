import { Link, type LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Inline } from "./Inline.tsx";
import { BETWEEN_LINES } from "./layout.ts";

/**
 * The bar above `s-page` on a signed-in area that has one: the site's name as the link home at
 * the start, `end` (who is signed in, Sign out) at the end, wrapping under it on a narrow
 * phone. `s-page` has no slot for chrome above its heading, so the bar is a plain bordered box
 * (`.top-bar` in `styles.css`). The home link is a router {@link Link}, so it navigates without
 * a document load.
 */
export function TopBar({
  title,
  to,
  end,
}: {
  readonly title: string;
  readonly to: LinkProps["to"];
  readonly end: ReactNode;
}) {
  return (
    <div className="top-bar">
      <s-stack
        direction="inline"
        gap={BETWEEN_LINES}
        alignItems="center"
        justifyContent="space-between"
      >
        <Link to={to} className="top-bar-home">
          {/* Strong, not a heading: the bar is chrome, and the page below has the heading. */}
          <s-text type="strong">{title}</s-text>
        </Link>
        <Inline>{end}</Inline>
      </s-stack>
    </div>
  );
}
