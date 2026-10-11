import { createFileRoute } from "@tanstack/react-router";
import MembersPage from "../components/MembersPage";
import { membersAtom } from "../backend-client.ts";
import { loadQuery } from "../query.ts";

export const Route = createFileRoute("/admin/members")({
  loader: async ({ context }) => {
    await loadQuery(context.registry, membersAtom);
  },
  component: MembersPage,
});
