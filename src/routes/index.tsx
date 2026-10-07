import { createFileRoute, useRouter } from "@tanstack/react-router";
import HomePage from "../components/HomePage";
import { ProbeHydration } from "../features/probe/ProbeHydration";
import { getProbe } from "../features/probe/loader";

export const Route = createFileRoute("/")({ loader: () => getProbe(), component: Home });

function Home() {
  const state = Route.useLoaderData();
  const { probeRegistry } = useRouter().options.context;
  return (
    <ProbeHydration state={state} serverOwned={probeRegistry !== undefined}>
      <HomePage />
    </ProbeHydration>
  );
}
