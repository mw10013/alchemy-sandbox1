import { createFileRoute, Outlet } from "@tanstack/react-router";
import MemberShell from "../components/MemberShell";
import { requireRole } from "./-guards.ts";

export const Route = createFileRoute("/app")({
  beforeLoad: requireRole("user"),
  component: () => (
    <MemberShell>
      <Outlet />
    </MemberShell>
  ),
});
