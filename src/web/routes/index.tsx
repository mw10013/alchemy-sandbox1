import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import HomePage from "../components/HomePage";
import { getHello, shout } from "../server/playground.ts";
import { getMe } from "../server/session.ts";

export const Route = createFileRoute("/")({
  // A failed Hello rejects, and the route error boundary shows it.
  loader: async () => {
    const [hello, me] = await Promise.all([getHello(), getMe()]);
    return { hello, me: me ?? undefined };
  },
  component: function HomeRoute() {
    const { hello, me } = Route.useLoaderData();
    const shoutFn = useServerFn(shout);
    return <HomePage me={me} hello={hello} shout={(input) => shoutFn({ data: { input } })} />;
  },
});
