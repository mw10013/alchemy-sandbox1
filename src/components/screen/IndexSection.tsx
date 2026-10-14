import type { ReactNode } from "react";

/**
 * A list's card: one `s-section` with no padding, so an `s-table` runs to the card's edge, as
 * in Shopify's index-table composition. A table inside a padded section floats in it.
 *
 * @see refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/index-table.md
 */
export function IndexSection({
  label,
  children,
}: {
  /** The list's noun, read by screen readers as the section's name. */
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <s-section padding="none" accessibilityLabel={label}>
      {children}
    </s-section>
  );
}
