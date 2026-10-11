import { createFileRoute } from "@tanstack/react-router";
import HomePanel from "../components/HomePanel";

export const Route = createFileRoute("/app/")({
  component: function MemberHome() {
    const { me } = Route.useRouteContext();
    return <HomePanel heading="Member area" email={me.email} />;
  },
});
