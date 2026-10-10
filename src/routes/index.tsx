import { createFileRoute } from "@tanstack/react-router";
import HomePage from "../components/HomePage";
import { getHello } from "../backend/functions";

export const Route = createFileRoute("/")({ loader: () => getHello(), component: Home });

function Home() {
  return <HomePage hello={Route.useLoaderData()} />;
}
