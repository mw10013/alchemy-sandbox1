import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env.server.ts";

// The only Better Auth endpoints the browser may reach. Everything else, including the
// endpoint that sends a magic link, goes through the Backend's RPCs.
const allowed = (method: string, pathname: string) =>
  (method === "GET" && pathname === "/api/auth/magic-link/verify") ||
  (method === "POST" && pathname === "/api/auth/sign-out");

const notFound = () =>
  new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });

// Browser → Website → Backend. The verify response is a redirect that sets the session
// cookie, so it is passed through to the browser rather than followed.
const forward = ({ request }: { request: Request }) =>
  allowed(request.method, new URL(request.url).pathname)
    ? env.BACKEND.fetch(new Request(request, { redirect: "manual" }))
    : notFound();

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: forward, POST: forward } },
});
