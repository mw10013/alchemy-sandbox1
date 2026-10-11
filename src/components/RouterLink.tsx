import type { ComponentProps } from "react";
import { Link } from "@tanstack/react-router";

// Astryx renders links through this (LinkProvider in __root), so they navigate client-side.
export default function RouterLink({ href, ...props }: ComponentProps<"a">) {
  return <Link to={href} {...props} />;
}
