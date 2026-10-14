import type { ReactNode } from "react";
import { BETWEEN_LINES } from "./layout.ts";

/** The lines of one thing stacked, such as a label over its value. */
export function Lines({ children }: { readonly children: ReactNode }) {
  return <s-stack gap={BETWEEN_LINES}>{children}</s-stack>;
}
