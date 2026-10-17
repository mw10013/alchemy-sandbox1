import type { ReactNode } from "react";
import { BETWEEN_LINES, BETWEEN_THINGS } from "./layout.ts";

/**
 * A list with nothing in it: one sentence in the list's place, centred in the list's frame, and
 * under it at most one action, the way out. Centred because a lone line in a card's corner
 * reads as leftover text rather than the answer. `heading` is for the never-filled list, whose
 * sentence explains a first step and needs a name above it ("No open orders").
 *
 * | part       | job                                                       | component   | fixes                        | used on | never                                            |
 * | ---------- | --------------------------------------------------------- | ----------- | ---------------------------- | ------- | ------------------------------------------------ |
 * | empty line | one sentence in the list's place, and at most one way out | `EmptyLine` | centred; at most 450px wide  | index   | an illustration; a link to an act on this screen |
 */
export function EmptyLine({
  heading,
  children,
  action,
}: {
  readonly heading?: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <s-box padding={BETWEEN_THINGS}>
      <s-grid justifyItems="center">
        <s-grid justifyItems="center" maxInlineSize="450px" gap={BETWEEN_LINES}>
          {heading !== undefined && <s-heading>{heading}</s-heading>}
          {children !== undefined && <s-paragraph color="subdued">{children}</s-paragraph>}
          {action}
        </s-grid>
      </s-grid>
    </s-box>
  );
}
