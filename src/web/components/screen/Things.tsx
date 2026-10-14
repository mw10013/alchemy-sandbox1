import type { ReactNode } from "react";
import { BETWEEN_THINGS } from "./layout.ts";

/**
 * Things stacked in one place that are not one thing's lines: a section's banners, text, form
 * and buttons, or a form's fields. Spaced by {@link BETWEEN_THINGS}, so one field's error never
 * runs into the next field's label; the lines of one thing are `Lines`.
 */
export function Things({ children }: { readonly children: ReactNode }) {
  return <s-stack gap={BETWEEN_THINGS}>{children}</s-stack>;
}
