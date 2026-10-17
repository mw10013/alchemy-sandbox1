import { createFileRoute } from "@tanstack/react-router";
import MemberHomePage from "../components/MemberHomePage.tsx";
import { listMyShops } from "../server/shop.ts";

export const Route = createFileRoute("/shop/")({
  loader: () => listMyShops(),
  component: function MemberHome() {
    return <MemberHomePage shops={Route.useLoaderData()} />;
  },
});
