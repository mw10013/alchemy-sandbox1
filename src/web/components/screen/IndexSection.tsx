import type { ReactNode } from "react";
import { BETWEEN_THINGS } from "./layout.ts";

/**
 * A list's card: one `s-section` with no padding, so an `s-table` runs to the card's edge, as
 * in Shopify's index-table composition. A table inside a padded section floats in it. `head`
 * holds what sits above the list (its banners), padded and spaced by {@link BETWEEN_THINGS};
 * `children` is the list: an `s-table`, or an `EmptyLine`; `foot` is what sits under it, the
 * way to the list's next page, padded the same and at the line's end, where a reader who
 * reached the last row looks next.
 *
 * @see refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/index-table.md
 */
export function IndexSection({
  label,
  head,
  children,
  foot,
}: {
  /** The list's noun, read by screen readers as the section's name. */
  readonly label: string;
  readonly head?: ReactNode;
  readonly children: ReactNode;
  readonly foot?: ReactNode;
}) {
  return (
    <s-section padding="none" accessibilityLabel={label}>
      {head !== undefined && head !== null && head !== false && (
        <s-box padding={BETWEEN_THINGS}>
          <s-stack gap={BETWEEN_THINGS}>{head}</s-stack>
        </s-box>
      )}
      {children}
      {foot !== undefined && foot !== null && foot !== false && (
        <s-box padding={BETWEEN_THINGS}>
          <s-stack direction="inline" justifyContent="end">
            {foot}
          </s-stack>
        </s-box>
      )}
    </s-section>
  );
}
