import type { ReactNode } from "react";
import { BETWEEN_THINGS } from "./layout.ts";

/**
 * A list's card: one `s-section` with no padding, so an `s-table` runs to the card's edge, as
 * in Shopify's index-table composition. A table inside a padded section floats in it. `head`
 * holds what sits above the list (its banners), padded and spaced by {@link BETWEEN_THINGS};
 * `children` is the list: an `s-table`, or an `EmptyLine`.
 *
 * @see refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/index-table.md
 */
export function IndexSection({
  label,
  head,
  children,
}: {
  /** The list's noun, read by screen readers as the section's name. */
  readonly label: string;
  readonly head?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <s-section padding="none" accessibilityLabel={label}>
      {head !== undefined && head !== null && head !== false && (
        <s-box padding={BETWEEN_THINGS}>
          <s-stack gap={BETWEEN_THINGS}>{head}</s-stack>
        </s-box>
      )}
      {children}
    </s-section>
  );
}
