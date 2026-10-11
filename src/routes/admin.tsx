import { createFileRoute, Outlet } from "@tanstack/react-router";
import AdminShell from "../components/AdminShell";
import { requireRole } from "./-guards.ts";

export const Route = createFileRoute("/admin")({
  beforeLoad: requireRole("admin"),
  component: () => (
    <AdminShell>
      <Outlet />
    </AdminShell>
  ),
});
