import { createFileRoute, Outlet } from "@tanstack/react-router";
import MemberBar from "../components/MemberBar.tsx";
import { requireRole } from "./-guards.ts";

/** The member area: the {@link MemberBar} above every page. */
export const Route = createFileRoute("/shop")({
  beforeLoad: requireRole("user"),
  component: function MemberArea() {
    const { me } = Route.useRouteContext();
    return (
      <>
        <MemberBar email={me.email} />
        <Outlet />
      </>
    );
  },
});
