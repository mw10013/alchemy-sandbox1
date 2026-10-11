import { createFileRoute } from "@tanstack/react-router";
import HomePanel from "../components/HomePanel";

export const Route = createFileRoute("/admin/")({
  component: function AdminHome() {
    const { me } = Route.useRouteContext();
    return <HomePanel heading="Admin" email={me.email} />;
  },
});
