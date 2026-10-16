import { createFileRoute } from "@tanstack/react-router";
import { requireRole } from "./-guards.ts";

/**
 * The admin's side. No bar: each page is a plain `s-page` with Sign out as its secondary
 * action, the home page lists the sections, and a sub-page leads back with a breadcrumb.
 */
export const Route = createFileRoute("/admin")({
  beforeLoad: requireRole("admin"),
});
