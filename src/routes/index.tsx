import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import HomePage from "../components/HomePage";
import { helloAtom } from "../backend-client.ts";
import { loadQuery } from "../query.ts";
import { currentMember } from "../session.ts";

export const Route = createFileRoute("/")({
  // A failed Hello rejects, and the route error boundary shows it.
  loader: async ({ context }) => {
    const [, me] = await Promise.all([
      loadQuery(context.registry, helloAtom),
      currentMember(context.registry),
    ]);
    return { me: Option.getOrUndefined(me) };
  },
  component: function HomeRoute() {
    const { me } = Route.useLoaderData();
    return <HomePage me={me} />;
  },
});
