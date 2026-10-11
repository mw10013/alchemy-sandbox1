import type { ComponentProps } from "react";
import { Link } from "@tanstack/react-router";

/**
 * Astryx renders its links through this (`LinkProvider` in the root route), so they navigate
 * client-side.
 */
export default function RouterLink({ href, ...props }: ComponentProps<"a">) {
  return <Link to={href} {...props} />;
}
