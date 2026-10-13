import { createFileRoute } from "@tanstack/react-router";
import MembersPage from "../components/MembersPage";
import { listMembers } from "../server/members.ts";

export const Route = createFileRoute("/admin/members")({
  loader: () => listMembers(),
  component: function MembersRoute() {
    return <MembersPage members={Route.useLoaderData()} />;
  },
});
