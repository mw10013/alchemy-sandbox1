import type { ReactNode } from "react";
import { BETWEEN_LINES } from "./layout.ts";

/**
 * Things side by side, wrapping when the line is full: a row of buttons, the end of the top
 * bar. Centred on the line, so a button sits level with the text beside it.
 */
export function Inline({ children }: { readonly children: ReactNode }) {
  return (
    <s-stack direction="inline" gap={BETWEEN_LINES} alignItems="center">
      {children}
    </s-stack>
  );
}
